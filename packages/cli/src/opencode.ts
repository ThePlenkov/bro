/**
 * bro as an opencode plugin — bro mechanics on opencode's native plugin bus.
 *
 * OpenCode ships no shell-hook manifest (the Claude/Devin/Codex adapters
 * ship hooks.json + run.sh). It loads JS/TS modules instead, so this file is
 * the whole adapter: every hook is one `bro hooks <event>` call with the
 * payload on stdin, and the hook control JSON that comes back on stdout is
 * translated into whatever that hook's output slot is called. No bro policy
 * lives here — arming, rehydration, the stop gate stay in the CLI, which is
 * the same contract the other adapters speak.
 *
 *   session "context" hook      → session-start       (cached per session)
 *   session.created event       → session-start       (primed off the hot path)
 *   session "compaction" hook   → pre-compact
 *   session "prompt" hook       → prompt-submit
 *   tool "execute.after" hook   → post-tool
 *   session.execution.succeeded → stop                (see below)
 *
 * Three deliberate deviations from the shell adapters:
 *
 * - **The stop gate re-prompts instead of blocking.** There is no pre-stop
 *   hook and no hook that can refuse a stop. The nearest equivalent is feeding
 *   the blocker back as a synthetic turn, ONCE per session: the first block
 *   re-prompts, every later one is logged and let through. That is bro's own
 *   "gates, not loops" rule, and Claude's `stop_hook_active` retry flag is
 *   emulated by the same in-memory set, so bro skips its own re-evaluation on
 *   the second pass.
 * - **A turn that did not complete cleanly never gates.** The gate keys on
 *   `session.execution.succeeded`, which opencode emits only for a finished
 *   execution — an aborted or failed turn never reaches it. So the "did the
 *   user abort?" bookkeeping the v1 adapter needed is structural here.
 * - **No permission auto-approve.** opencode v2 replaced the per-ask
 *   `permission.ask` hook with a declarative rules API, and in 2.0.22
 *   `ctx.permission.rules` is not even a function. bro's allow decision is a
 *   function of the actual command string (`isSelfToolCommand`), and the only
 *   remaining expression is a glob — which would happily allow
 *   `bd ready && rm -rf /`. Approving nothing is the honest answer until
 *   opencode ships a per-ask hook; one click per command is a fair price for
 *   not shipping a privilege-escalation footgun.
 *
 * Fail-open is the whole contract. Every hook is wrapped, a missing bro binary
 * is not an error, and a spawn that throws, times out, exits nonzero or prints
 * garbage yields no context and no block. Nothing here may throw into opencode.
 *
 * Every spawn is ASYNC on purpose. Plugin hooks run on opencode's event loop,
 * so a synchronous child would freeze the session — and bro's probes are not
 * cheap: `hooks session-start` measures 20-40s in a loaded repo (it lists the
 * `bd ready` queue and walks the sibling worktrees). That budget is why
 * rehydration is primed on `session.created` instead of on the first turn.
 *
 * The CLI is spawned with `node` from PATH, never `process.execPath` — see
 * `jsRuntime()` below for why that distinction is load-bearing.
 *
 * Upstream hook shapes mirror `@opencode/plugin` v2. Declared structurally
 * rather than imported: that package is not published yet (`@opencode-ai/plugin`
 * is still stuck at 1.18.34), and a devDependency would drag its effect/zod/
 * aisdk trees into the repo for types alone. Field names are verbatim; upstream
 * is the only place they should change.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Level = 'debug' | 'info' | 'warn' | 'error'

interface SessionEvent {
  type: string
  data?: { sessionID?: string; [key: string]: unknown }
}

interface ToolAfterEvent {
  tool?: string
  sessionID?: string
  input?: unknown
  status?: string
  result?: { output?: { output?: unknown; exit?: number } }
}

/** The one control object `bro hooks <event>` prints. `decision`/`reason`
 *  carry the stop gate; `additionalContext` carries everything the probes want
 *  the agent to read. */
interface HookControl {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown }
  decision?: string
  reason?: unknown
}

interface Command {
  cmd: string
  args: string[]
}

/** Per-probe budget for the events that ride on a turn. A wedged connector
 *  already costs up to 4s each and bro runs probes sequentially, so this is an
 *  outer bound, not the expected wait — on timeout the event degrades to "no
 *  context", which is the fail-open answer anyway. */
const HOOK_TIMEOUT_MS = 15_000

/** Rehydration gets a longer budget because it shells out to `bd ready` and
 *  scans the worktree set — measured at 20-40s in a loaded repo. It is primed
 *  on `session.created` (see below) so that cost overlaps the user's first
 *  prompt instead of serializing after it. */
const REHYDRATION_TIMEOUT_MS = 45_000

const MAX_OUTPUT = 1 << 20

/** The runtime that executes the sibling CLI.
 *
 *  NOT `process.execPath`. opencode ships as a compiled binary, so inside its
 *  own plugin process `process.execPath` IS opencode — spawning it with
 *  `hooks <event>` starts a TUI instead of running the hook, and the plugin
 *  fails open into silence. `node` on PATH is the right ask anyway: it is what
 *  bro itself requires (`engines.node >= 22.18`), it is what hooks/run.sh
 *  resolves, and the CLI is plain ESM JS, so any runtime will do. */
export function jsRuntime(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * The CLI shipped beside this module: installed as
 * `node_modules/@broject/bro/dist/{opencode,index}.js`, built in a checkout as
 * `packages/cli/dist/{opencode,index}.js`. Same package, so the hook policy
 * can never be a different version than the plugin calling it.
 */
function siblingCli(): string | null {
  for (const rel of ['./index.js', '../dist/index.js']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** Does a PATH `bro` actually answer `bro hooks`? Without an event the hook
 *  command is a silent no-op, so exit 0 is the probe — an older bro without
 *  the subcommand fails it instead of failing every hook. Same discriminator
 *  hooks/run.sh uses. */
function hasHooksCommand(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // PATH lookup is the point of this tier — a partial install has no
      // bundled CLI, and the probe below verifies the answer before any hook
      // trusts it
      child = spawn('bro', ['hooks'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
      }) // NOSONAR typescript:S4036
    } catch {
      resolve(false)
      return
    }
    const timer = killAfter(child, HOOK_TIMEOUT_MS, () => resolve(false))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end('')
  })
}

/** SIGKILL a hung child on a timer. The spawns below are detached, so the
 *  child leads its own process group and `-pid` takes a spawned `gh`/`bd`
 *  down with it — a lone child.kill would leave them orphaned. */
function killAfter(
  child: ChildProcess,
  ms: number,
  onTimeout: () => void
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      // no group to kill (not detached, already gone, or windows)
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    onTimeout()
  }, ms)
  timer.unref?.()
  return timer
}

async function resolveCommand(options: PluginOptions | undefined): Promise<Command | null> {
  const override = options?.command
  if (typeof override === 'string' && override.trim() !== '') {
    return { cmd: override, args: [] }
  }
  if (override && typeof override === 'object' && typeof override.cmd === 'string') {
    return {
      cmd: override.cmd,
      args: Array.isArray(override.args)
        ? override.args.filter((a): a is string => typeof a === 'string')
        : [],
    }
  }
  const entry = siblingCli()
  if (entry) {
    return { cmd: jsRuntime(), args: [entry] }
  }
  // partial install — no bundled CLI next to the plugin. Fall back to PATH,
  // and only to a bro that passes the hooks probe.
  return (await hasHooksCommand()) ? { cmd: 'bro', args: [] } : null
}

/** Run one bro hook event. Resolves null for every failure mode, including
 *  "bro isn't there" — the caller's only question is whether a valid control
 *  object came back.
 *
 *  Async spawn, not spawnSync: hooks run on opencode's event loop, so a
 *  synchronous child would freeze the whole session — and bro's rehydration
 *  probes are measured in tens of seconds, not milliseconds. */
function callHook(
  command: Command,
  event: string,
  payload: unknown,
  directory: string,
  timeoutMs: number
): Promise<HookControl | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command.cmd, [...command.args, 'hooks', event], {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'ignore'],
        // own process group so killAfter can take spawned children down too
        detached: process.platform !== 'win32',
      }) // NOSONAR typescript:S4036
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const settle = (value: HookControl | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const timer = killAfter(child, timeoutMs, () => settle(null))
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const remaining = MAX_OUTPUT - out.length
      if (remaining > 0) {
        out += chunk.slice(0, remaining)
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      settle(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // `bro hooks` always exits 0; anything else means the run failed, and a
      // failed run's stdout is not a control object even if it parses
      settle(code === 0 ? parseControl(out) : null)
    })
    // bro can exit before reading stdin (unrecognized event) — EPIPE here is
    // bro's answer, not a crash
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(payload))
  })
}

/** bro prints a single control object per event, but scan for the first
 *  parseable line so unrelated chatter on stdout can't swallow the answer. */
function parseControl(out: string): HookControl | null {
  for (const line of out.split('\n')) {
    const text = line.trim()
    if (!text) {
      continue
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as HookControl
      }
    } catch {
      // not a control line — keep scanning
    }
  }
  return null
}

function contextOf(control: HookControl | null): string {
  const text = control?.hookSpecificOutput?.additionalContext
  return typeof text === 'string' ? text.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Did the tool succeed? bro arms its gates and cites skills only on success,
 *  so a false positive here is worse than a false negative.
 *
 *  opencode v2 reports `status: "completed"` and carries the exit code at
 *  `result.output.exit` — there is no `error` key to key on, so a failed shell
 *  command would otherwise read as a success and arm bro's gates for work that
 *  never happened. */
export function toolSucceeded(event: ToolAfterEvent): boolean {
  if (event.status !== undefined && event.status !== 'completed') {
    return false
  }
  const exit = event.result?.output?.exit
  return typeof exit === 'number' ? exit === 0 : true
}

/** opencode hands a shell command to the model as plain text, so appending
 *  probe context to the prompt is the faithful analogue of Claude's
 *  UserPromptSubmit additionalContext. */
function appendContext(base: unknown, context: string): unknown {
  return typeof base === 'string' && base ? `${base}\n\n${context}` : context
}

/** The tool result text, wherever this opencode build put it. */
function toolOutputText(event: ToolAfterEvent): { text: string; write: (next: string) => void } {
  const output = event.result?.output
  const text = typeof output?.output === 'string' ? output.output : ''
  return {
    text,
    write(next: string) {
      if (output && typeof output === 'object') {
        output.output = next
      }
    },
  }
}

/** `["@broject/bro", { command: … }]` — opencode passes options through from
 *  `plugins: [{ package, options }]`. The override is a real escape hatch (pin
 *  a specific bro build) and the seam the tests drive; unresolvable options
 *  degrade to the default ladder. */
interface PluginOptions {
  command?: string | { cmd: string; args?: string[] }
}

interface BroSetupContext {
  location?: { directory?: string }
  options?: PluginOptions
  event?: { subscribe(o?: { signal?: AbortSignal }): AsyncIterable<SessionEvent> }
  session?: {
    hook(
      name: string,
      handler: (event: Record<string, unknown>) => void | Promise<void>
    ): Promise<unknown>
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>
  }
  tool?: {
    hook(
      name: string,
      handler: (event: ToolAfterEvent) => void | Promise<void>
    ): Promise<unknown>
  }
  app?: { log(input: { body: { service: string; level: Level; message: string } }): Promise<unknown> }
}

export default {
  id: 'bro',
  async setup(ctx: BroSetupContext) {
    const directory = ctx.location?.directory ?? process.cwd()
    // resolved on first use, not at setup — the PATH tier costs a spawn probe
    // and opencode loads plugins even in repos where bro is inert.
    let command: Promise<Command | null> | undefined

    const log = (level: Level, message: string): Promise<unknown> => {
      try {
        return Promise.resolve(
          ctx.app?.log({ body: { service: 'bro', level, message } })
        ).catch(() => undefined)
      } catch {
        return Promise.resolve(undefined)
      }
    }

    const probe = async (
      event: string,
      payload: unknown,
      timeoutMs = HOOK_TIMEOUT_MS
    ): Promise<HookControl | null> => {
      command ??= resolveCommand(ctx.options)
      const resolved = await command
      return resolved ? callHook(resolved, event, payload, directory, timeoutMs) : null
    }

    /** Rehydration is per session, not per turn: the context hook runs on every
     *  model call, so the probe runs once and its answer is re-pushed each
     *  time. The cache holds the in-flight promise, not its result, so a
     *  `session.created` prime and the first turn racing each other share one
     *  probe instead of two. A FAILED probe is evicted rather than cached —
     *  timing out once is not the session's verdict, and the next turn deserves
     *  a retry; only a real answer (including an empty one) is sticky. */
    const rehydration = new Map<string, Promise<string>>()
    const hydrate = (
      sessionID: string,
      event: 'session-start' | 'post-compaction'
    ): Promise<string> => {
      const pending = rehydration.get(sessionID)
      if (pending) {
        return pending
      }
      const started = probe(event, { session_id: sessionID }, REHYDRATION_TIMEOUT_MS).then(
        (control) => {
          if (control === null) {
            rehydration.delete(sessionID)
          }
          return contextOf(control)
        }
      )
      rehydration.set(sessionID, started)
      return started
    }

    /** Sessions that already got their one re-prompt. */
    const gated = new Set<string>()

    const forget = (sessionID: string): void => {
      rehydration.delete(sessionID)
      gated.delete(sessionID)
    }

    /** `session.created` primes rehydration while opencode is still waiting on
     *  a prompt — the probe costs real seconds, and this is the only window
     *  where paying it does not sit on the critical path of a turn. */
    const onSessionCreated = (event: SessionEvent): void => {
      const sessionID = event.data?.sessionID
      if (typeof sessionID === 'string') {
        void hydrate(sessionID, 'session-start')
      }
    }

    /** `session.deleted` retires the per-session structures — they live as
     *  long as the plugin process, not the session, so without this a
     *  long-lived server accumulates dead entries. */
    const onSessionDeleted = (event: SessionEvent): void => {
      const sessionID = event.data?.sessionID
      if (typeof sessionID === 'string') {
        forget(sessionID)
      }
    }

    /** `session.execution.succeeded` is the stop gate, and it is also the
     *  clean-turn signal: opencode emits it only for a completed execution, so
     *  an aborted or failed turn never arrives here and needs no separate
     *  detection. Gated sessions pass `stop_hook_active`, so bro skips its own
     *  re-evaluation — the one-shot guard is bro's, not duplicated here. */
    const onExecutionSucceeded = async (event: SessionEvent): Promise<void> => {
      const sessionID = event.data?.sessionID
      if (typeof sessionID !== 'string') {
        return
      }
      const control = await probe('stop', {
        session_id: sessionID,
        stop_hook_active: gated.has(sessionID),
      })
      const reason = typeof control?.reason === 'string' ? control.reason.trim() : ''
      if (control?.decision !== 'block') {
        const hint = contextOf(control)
        if (hint) {
          await log('info', hint)
        }
        return
      }
      await log('warn', `stop gate: ${reason || 'unfinished bro work'}`)
      if (gated.has(sessionID)) {
        return
      }
      gated.add(sessionID)
      try {
        await ctx.session?.synthetic({ sessionID, text: reason })
      } catch (err) {
        await log('error', `stop gate could not re-prompt: ${errorText(err)}`)
      }
    }

    const onEvent = async (event: SessionEvent): Promise<void> => {
      try {
        switch (event.type) {
          case 'session.created':
            onSessionCreated(event)
            break
          case 'session.compacted':
            // re-primes the cache so the next turn pushes post-compaction state
            // instead of the pre-compaction snapshot
            {
              const sessionID = event.data?.sessionID
              if (typeof sessionID === 'string') {
                rehydration.delete(sessionID)
                void hydrate(sessionID, 'post-compaction')
              }
            }
            break
          case 'session.execution.succeeded':
            await onExecutionSucceeded(event)
            break
          case 'session.deleted':
            onSessionDeleted(event)
            break
        }
      } catch (err) {
        await log('error', `event ${event.type} failed: ${errorText(err)}`)
      }
    }

    const controller = new AbortController()
    const subscribe = ctx.event?.subscribe
    if (subscribe) {
      void (async () => {
        try {
          for await (const event of subscribe({ signal: controller.signal })) {
            await onEvent(event)
          }
        } catch {
          // the stream ends when the signal aborts on unload — not an error
        }
      })()
    }

    /** Wraps a handler so nothing bro does can throw into opencode. */
    const guard =
      <T,>(name: string, handler: (event: T) => Promise<void> | void) =>
      async (event: T): Promise<void> => {
        try {
          await handler(event)
        } catch (err) {
          await log('error', `${name} failed: ${errorText(err)}`)
        }
      }

    await ctx.session?.hook(
      'context',
      guard('context hook', async (event) => {
        const sessionID = event.sessionID
        if (typeof sessionID !== 'string') {
          return
        }
        const text = await hydrate(sessionID, 'session-start')
        if (text && Array.isArray(event.system)) {
          ;(event.system as unknown[]).push({ type: 'text', text })
        }
      })
    )

    await ctx.session?.hook(
      'compaction',
      guard('compaction hook', async (event) => {
        const sessionID = event.sessionID
        if (typeof sessionID !== 'string') {
          return
        }
        const text = contextOf(
          await probe('pre-compact', { session_id: sessionID }, REHYDRATION_TIMEOUT_MS)
        )
        // the compaction hook hands over the transcript being summarized; a
        // trailing note is the only injection point this build exposes
        if (text && Array.isArray(event.messages)) {
          ;(event.messages as unknown[]).push({ role: 'user', text })
        }
      })
    )

    await ctx.session?.hook(
      'prompt',
      guard('prompt hook', async (event) => {
        const sessionID = event.sessionID
        const prompt = asRecord(event.prompt)
        if (typeof sessionID !== 'string' || !prompt) {
          return
        }
        const text = contextOf(
          await probe('prompt-submit', {
            session_id: sessionID,
            prompt: typeof prompt.text === 'string' ? prompt.text : '',
          })
        )
        if (text) {
          prompt.text = appendContext(prompt.text, text)
        }
      })
    )

    await ctx.tool?.hook(
      'execute.after',
      guard<ToolAfterEvent>('tool hook', async (event) => {
        if (!event.sessionID) {
          return
        }
        const input = asRecord(event.input) ?? {}
        const text = contextOf(
          await probe('post-tool', {
            session_id: event.sessionID,
            tool_name: event.tool,
            tool_input: input,
            tool_response: { success: toolSucceeded(event) },
          })
        )
        if (text) {
          const result = toolOutputText(event)
          result.write(`${result.text}\n\n${text}`)
        }
      })
    )

    return () => {
      controller.abort()
    }
  },
}