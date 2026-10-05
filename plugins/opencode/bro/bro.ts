/**
 * bro as an OpenCode plugin — bro mechanics on opencode's native hook bus.
 *
 * OpenCode ships no shell-hook manifest (the Claude/Devin/Codex adapters
 * ship hooks.json + run.sh). It loads JS/TS modules and calls the `Hooks`
 * object they return, so this file is the whole adapter: every hook is one
 * `bro hooks <event>` call with the payload on stdin, and the hook control
 * JSON that comes back on stdout is translated into whatever that hook's
 * output slot is called. No bro policy lives here — arming, rehydration, the
 * stop gate and permission auto-approve stay in the CLI, which is the same
 * contract the other three adapters speak.
 *
 *   system.transform            → session-start       (cached per session)
 *   session.compacted event     → post-compaction     (re-primes the cache)
 *   session.compacting hook     → pre-compact
 *   chat.message                → prompt-submit
 *   tool.execute.after          → post-tool
 *   session.idle event          → stop                (see below)
 *   permission.ask              → permission
 *
 * Two deliberate deviations from the shell adapters:
 *
 * - **The stop gate re-prompts instead of blocking.** opencode has no pre-stop
 *   hook — `session.idle` arrives after the turn is over, and nothing can
 *   refuse the stop. The nearest equivalent is feeding the blocker back as a
 *   synthetic turn, ONCE per session: the first block re-prompts, every later
 *   one is logged and let through. That is bro's own "gates, not loops" rule,
 *   and Claude's `stop_hook_active` retry flag is emulated by the same
 *   in-memory set, so bro skips its own re-evaluation on the second pass.
 * - **Only a cleanly finished turn gates.** `session.idle` also fires when the
 *   user aborts or the provider errors. Re-prompting a user who hit ESC is
 *   hostile, so the gate needs an assistant message carrying `time.completed`
 *   and no `error` — tracked from `message.updated`, which opencode delivers
 *   before the matching idle.
 *
 * Fail-open is the whole contract. Every hook is wrapped, a missing bro binary
 * is not an error, and a spawn that throws, times out, exits nonzero or prints
 * garbage yields no context, no permission and no re-prompt. Nothing in this
 * file may throw into opencode.
 *
 * Every spawn is ASYNC on purpose. Plugin hooks run on opencode's server event
 * loop, so a synchronous child would freeze the session — and bro's probes are
 * not cheap: `hooks session-start` measures 20-40s in a loaded repo (it lists
 * the `bd ready` queue and walks the sibling worktrees). That budget is why
 * rehydration is primed on `session.created` instead of on the first turn.
 *
 * The CLI is spawned with `node` from PATH, never `process.execPath` — see
 * `jsRuntime()` below for why that distinction is load-bearing.
 *
 * Upstream hook shapes mirror `@opencode-ai/plugin` 1.18.x, declared
 * structurally rather than imported: opencode loads this module at runtime and
 * nobody typechecks it against the real package, so a devDependency on
 * `@opencode-ai/plugin` would buy type fidelity at the cost of dragging its
 * sdk/effect/zod trees into the repo for types alone. Field names are verbatim;
 * upstream is the only place they should change.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LogInput {
  body: { service: string; level: Level; message: string; extra?: unknown }
}

interface PermissionAsk {
  id?: string
  type?: string
  permission?: string
  pattern?: string | string[]
  patterns?: string[]
  sessionID?: string
  metadata?: Record<string, unknown>
}

interface EventEnvelope {
  type: string
  properties?: Record<string, unknown>
}

interface PluginInput {
  directory: string
  client?: {
    app?: { log(input: LogInput): Promise<unknown> }
    session?: {
      promptAsync(input: {
        path: { id: string }
        body: { parts: { type: 'text'; text: string }[] }
      }): Promise<unknown>
    }
  }
}

/** `["@broject/bro", { command: … }]` — opencode's tuple plugin form. The
 *  override is a real escape hatch (pin a specific bro build) and the seam
 *  the tests drive; unresolvable options degrade to the default ladder. */
interface PluginOptions {
  command?: string | { cmd: string; args?: string[] }
}

interface Hooks {
  event?(input: { event: EventEnvelope }): Promise<void>
  'chat.message'?(
    input: { sessionID: string },
    output: { parts: { type: string; text?: string }[] }
  ): Promise<void>
  'permission.ask'?(input: PermissionAsk, output: { status: 'ask' | 'deny' | 'allow' }): Promise<void>
  'tool.execute.after'?(
    input: { tool: string; sessionID: string; args?: unknown },
    output: { output: string; metadata?: unknown }
  ): Promise<void>
  'experimental.chat.system.transform'?(
    input: { sessionID?: string },
    output: { system: string[] }
  ): Promise<void>
  'experimental.session.compacting'?(
    input: { sessionID: string },
    output: { context: string[] }
  ): Promise<void>
}

/** The one control object `bro hooks <event>` prints. `decision`/`reason`
 *  carry the stop gate and permission answers; `additionalContext` carries
 *  everything the probes want the agent to read. */
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

/** Walk up from this module for a checkout build — a bro.ts materialized
 *  into `.opencode/plugins/` or `plugins/opencode/bro/` inside a bro
 *  clone resolves the clone's own `packages/cli/dist/index.js`, so hook
 *  behavior tracks the checkout. Same walk `.kilo/plugin/bro.ts` and
 *  `hooks/run.sh` already do. */
function checkoutCli(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

/** Last-resort npx package spec, pinned to this module's own version —
 *  gen-plugins lists this file in VERSIONED_SOURCES, so the pin is
 *  rewritten to plugin.json's version on every gen/release run. */
const NPX_PIN = '@broject/bro@0.2.4'

/** Spawn `cmd args`, resolve true iff it exits 0 within the hook budget. One
 *  probe serves both launch tiers: `bro hooks` answers "is this a bro that
 *  speaks the hook contract", `node --version` answers "can the bundled CLI
 *  even start". A spawn error, timeout, or nonzero exit is "no" — selecting
 *  a command that cannot launch is worse than falling through to the next
 *  tier. */
function exitsZero(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // PATH lookup is the point of both tiers — the probe verifies the
      // answer before any hook trusts it
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' }) // NOSONAR typescript:S4036
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

/** Does a PATH `bro` actually answer `bro hooks`? Without an event the hook
 *  command is a silent no-op, so exit 0 is the probe — an older bro without
 *  the subcommand fails it instead of failing every hook. Same discriminator
 *  hooks/run.sh uses. */
function hasHooksCommand(): Promise<boolean> {
  return exitsZero('bro', ['hooks'])
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
  // local-dist tiers: the bundled sibling (npm `plugin` config-entry form)
  // first, then the checkout walk-up for a materialized module inside a
  // clone. A found CLI still needs `node` on PATH to launch, and opencode
  // itself is a compiled binary that guarantees no such thing — without
  // the probe this tier would win over a working PATH `bro` and every
  // hook would fail open into silence
  const entry = siblingCli() ?? checkoutCli()
  if (entry && (await exitsZero(jsRuntime(), ['--version']))) {
    return { cmd: jsRuntime(), args: [entry] }
  }
  // no local dist — fall back to PATH, and only to a bro that passes the
  // hooks probe.
  if (await hasHooksCommand()) {
    return { cmd: 'bro', args: [] }
  }
  // last resort mirrors hooks/run.sh: the published package via npx,
  // probed cheaply (the hook call itself carries the hook budget — a cold
  // npx resolve degrades to no-context for that turn, not a hang)
  if (await exitsZero('npx', ['--version'])) {
    return { cmd: 'npx', args: ['-y', '--prefer-offline', NPX_PIN] }
  }
  return null
}

/** Run one bro hook event. Resolves null for every failure mode, including
 *  "bro isn't there" — the caller's only question is whether a valid control
 *  object came back.
 *
 *  Async spawn, not spawnSync: opencode runs plugin hooks on the server's event
 *  loop, so a synchronous child would freeze the whole session — and bro's
 *  rehydration probes are measured in tens of seconds, not milliseconds. */
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
      })
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

/** opencode describes a bash ask by `patterns` — one entry per command
 *  segment — while the older `Permission` shape used `pattern`, and other
 *  tools carry the command in metadata. Joining keeps the whole ask visible
 *  to the classifier: `bd ready` approves, `bd ready && rm -rf x` must not.
 *  Either way bro's classifier wants the raw command string in the slot
 *  Claude puts it. */
function permissionCommand(input: PermissionAsk): string {
  if (Array.isArray(input.patterns) && input.patterns.length > 0) {
    return input.patterns.join(' && ')
  }
  if (typeof input.pattern === 'string') {
    return input.pattern
  }
  if (Array.isArray(input.pattern) && input.pattern.length === 1) {
    return input.pattern[0] ?? ''
  }
  for (const key of ['command', 'cmd', 'pattern']) {
    const value = input.metadata?.[key]
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
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
 *  opencode's bash metadata is `{ output, exit, truncated }` — there is no
 *  `error` field on a nonzero exit, so keying on `error` alone reads every
 *  failure as a success. Honour `exit` when the tool reports it and fall back
 *  to the error key for tools that only set that. */
export function toolSucceeded(metadata: Record<string, unknown> | null): boolean {
  if (metadata?.error !== undefined) {
    return false
  }
  return typeof metadata?.exit === 'number' ? metadata.exit === 0 : true
}

export const BroPlugin = (
  input: PluginInput,
  options?: PluginOptions
): Promise<Hooks> => {
  const directory = input.directory
  // resolved on first use, not at load — the PATH tier costs a spawn probe
  // and opencode loads plugins even in repos where bro is inert.
  let command: Promise<Command | null> | undefined

  const log = (level: Level, message: string): Promise<unknown> => {
    try {
      return Promise.resolve(
        input.client?.app?.log({ body: { service: 'bro', level, message } })
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
    command ??= resolveCommand(options)
    const resolved = await command
    return resolved ? callHook(resolved, event, payload, directory, timeoutMs) : null
  }

  /** Rehydration is per session, not per turn: system.transform runs on every
   *  request, so the probe runs once and the answer is re-pushed each turn —
   *  which is also what carries it across compaction. The cache holds the
   *  in-flight promise, not its result, so a `session.created` prime and a
   *  first turn racing each other share one probe instead of two. A FAILED
   *  probe is evicted rather than cached — timing out once is not the
   *  session's verdict, and the next turn deserves a retry; only a real
   *  answer (including an empty one) is sticky. */
  const rehydration = new Map<string, Promise<string>>()
  const hydrate = (sessionID: string, event: 'session-start' | 'post-compaction'): Promise<string> => {
    const pending = rehydration.get(sessionID)
    if (pending) {
      return pending
    }
    const started = probe(event, { session_id: sessionID }, REHYDRATION_TIMEOUT_MS).then((control) => {
      if (control === null) {
        rehydration.delete(sessionID)
      }
      return contextOf(control)
    })
    rehydration.set(sessionID, started)
    return started
  }
  /** Sessions that already got their one re-prompt. */
  const gated = new Set<string>()
  /** Sessions whose last assistant turn finished cleanly. */
  const clean = new Set<string>()
  /** Sessions observed alive. `session.deleted` is the only retirement, and
   *  the idle gate suspends on real I/O — liveness is re-checked after each
   *  await rather than assumed. */
  const live = new Set<string>()

  /** `session.created` primes rehydration while opencode is still waiting on a
   *  prompt — the probe costs real seconds, and this is the only window where
   *  paying it doesn't sit on the critical path of a turn. */
  const onSessionCreated = (props: Record<string, unknown>): void => {
    const sessionID = props.sessionID
    if (typeof sessionID === 'string') {
      live.add(sessionID)
      void hydrate(sessionID, 'session-start')
    }
  }

  /** `message.updated` arrives before the matching `session.idle` —
   *  `time.completed` with no `error` is what separates a finished turn from
   *  one the user aborted or the provider failed. The latest assistant update
   *  is the verdict: a clean step followed by one that aborts, errors, or is
   *  still streaming erases the earlier completion. */
  const onMessageUpdated = (props: Record<string, unknown>): void => {
    const info = asRecord(props.info)
    if (info?.role !== 'assistant' || typeof info.sessionID !== 'string') {
      return
    }
    live.add(info.sessionID)
    if (asRecord(info.time)?.completed !== undefined && info.error === undefined) {
      clean.add(info.sessionID)
    } else {
      clean.delete(info.sessionID)
    }
  }

  /** `session.deleted` retires the per-session structures — they live as
   *  long as the plugin process, not the session, so without this a
   *  long-lived server accumulates dead entries. */
  const onSessionDeleted = (props: Record<string, unknown>): void => {
    const sessionID = asRecord(props.info)?.id ?? props.sessionID
    if (typeof sessionID !== 'string') {
      return
    }
    rehydration.delete(sessionID)
    gated.delete(sessionID)
    clean.delete(sessionID)
    live.delete(sessionID)
  }

  /** `session.compacted` re-primes the cache so the next turn pushes
   *  post-compaction state instead of the pre-compaction snapshot. */
  const onSessionCompacted = (props: Record<string, unknown>): void => {
    const sessionID = props.sessionID
    if (typeof sessionID !== 'string') {
      return
    }
    rehydration.delete(sessionID)
    void hydrate(sessionID, 'post-compaction')
  }

  /** `session.idle` is the stop gate. Gated sessions pass `stop_hook_active`,
   *  so bro skips its own re-evaluation — the one-shot guard is bro's, not
   *  duplicated here. */
  const onSessionIdle = async (props: Record<string, unknown>): Promise<void> => {
    const sessionID = props.sessionID
    if (typeof sessionID !== 'string' || !clean.delete(sessionID)) {
      return
    }
    const control = await probe('stop', {
      session_id: sessionID,
      stop_hook_active: gated.has(sessionID),
    })
    const reason =
      typeof control?.reason === 'string' ? control.reason.trim() : ''
    if (control?.decision !== 'block') {
      const hint = contextOf(control)
      if (hint) {
        await log('info', hint)
      }
      return
    }
    // the probe awaited real I/O — a session.deleted that interleaved retired
    // this id, and gating it now would resurrect the entry and suppress a
    // session reusing it. The gate is set before the log/prompt awaits for
    // the same reason: a delete during them must clear it, not race it.
    if (!live.has(sessionID) || gated.has(sessionID)) {
      return
    }
    gated.add(sessionID)
    const message = reason || 'unfinished bro work'
    await log('warn', `stop gate: ${message}`)
    try {
      await input.client?.session?.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: 'text', text: message }] },
      })
    } catch (err) {
      await log('error', `stop gate could not re-prompt: ${errorText(err)}`)
    }
  }

  return Promise.resolve({
    async 'experimental.chat.system.transform'(hookInput, output) {
      const sessionID = hookInput.sessionID
      if (!sessionID) {
        return
      }
      const text = await hydrate(sessionID, 'session-start')
      if (text) {
        output.system.push(text)
      }
    },

    async 'experimental.session.compacting'(hookInput, output) {
      const text = contextOf(
        await probe('pre-compact', { session_id: hookInput.sessionID }, REHYDRATION_TIMEOUT_MS)
      )
      if (text) {
        output.context.push(text)
      }
    },

    async 'chat.message'(hookInput, output) {
      const prompt = output.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
      const text = contextOf(await probe('prompt-submit', { session_id: hookInput.sessionID, prompt }))
      if (text) {
        output.parts.push({ type: 'text', text })
      }
    },

    async 'tool.execute.after'(hookInput, output) {
      const metadata = asRecord(output.metadata)
      const text = contextOf(
        await probe('post-tool', {
          session_id: hookInput.sessionID,
          tool_name: hookInput.tool,
          tool_input: asRecord(hookInput.args) ?? {},
          tool_response: { success: toolSucceeded(metadata) },
        })
      )
      if (text) {
        output.output = `${output.output}\n\n${text}`
      }
    },

    async 'permission.ask'(hookInput, output) {
      const command = permissionCommand(hookInput)
      if (!command) {
        return
      }
      const control = await probe('permission', {
        tool_input: { command },
        session_id: hookInput.sessionID,
      })
      if (control?.decision === 'approve') {
        output.status = 'allow'
      }
    },

    async event({ event }) {
      const props = event.properties ?? {}
      switch (event.type) {
        case 'session.created':
          onSessionCreated(props)
          break
        case 'message.updated':
          onMessageUpdated(props)
          break
        case 'session.compacted':
          onSessionCompacted(props)
          break
        case 'session.deleted':
          onSessionDeleted(props)
          break
        case 'session.idle':
          await onSessionIdle(props)
          break
      }
    },
  })
}

/** opencode's loader requires a v1 module — a default export carrying `id`
 *  (a file plugin MUST declare one) and `server`. */
export default { id: 'bro', server: BroPlugin }