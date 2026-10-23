/**
 * The shared bro adapter driver.
 *
 * The core (adapter/core.ts) knows how to *ask* bro. This module knows
 * *when* to ask and what to do with the answer — and it does so once,
 * for every host. A client adapter supplies only the host's own shape:
 * its event names, its UI calls, and how it spells "refuse to stop".
 *
 * That split is the whole point. Before it, each client re-implemented
 * the same lifecycle (hydrate → nudge → inject → arm → gate) and the
 * same CLI ladder, and the copies drifted: pi had no `options.command`
 * tier, kilo's doc claimed an npx tier its code never had. One driver
 * cannot drift from itself.
 *
 * ## The host contract
 *
 * `BroHostBinding` is deliberately small — it is the *difference*
 * between hosts, nothing else. Everything else (probe ordering, cache
 * lifetimes, fail-open behavior) lives here.
 *
 * ## Lifecycle
 *
 *   session_start ──▶ probe session-start ──▶ cache hydration
 *                          │
 *   before_agent_start ◀──┴──▶ probe prompt-submit ──▶ inject
 *                              hydration + nudge (one hidden message)
 *
 *   tool_result ──▶ probe post-tool ──▶ arm the session, append a nudge
 *
 *   session_stop ──▶ probe stop ──▶ refuse the stop, or let it land
 *
 * The stop gate is the one place bro *blocks* rather than advises, so
 * it is the one place the driver is careful: the host says whether it
 * already refused once (omp reports `stop_hook_active`; pi needs a
 * local flag), and the driver passes that back to bro so bro's own
 * one-shot rule decides.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  HOOK_TIMEOUT_MS,
  REHYDRATION_TIMEOUT_MS,
  boardLines,
  broEnabled,
  callHook,
  contextOf,
  resolveCommand,
  statusCrumb,
  statusJson,
  type BoardStatus,
  type Command,
  type HookControl,
} from './core.ts'

/** How a host spells the things the driver needs.
 *
 *  Generic over the host's context type: the driver passes the host's
 *  own context object through, so the binding can read `ctx.ui` and
 *  `ctx.cwd` without a cast at every call site. */
export interface BroHostBinding<Ctx = unknown> {
  /** The host's event names. A host without one of these omits the
   *  key and the driver skips that behavior. */
  readonly events: {
    sessionStart?: string
    sessionBeforeCompact?: string
    sessionCompact?: string
    beforeAgentStart?: string
    toolResult?: string
    stop?: string
    turnEnd?: string
    sessionShutdown?: string
  }
  /** Register a handler. */
  on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void
  /** The host's session id — empty when it has none. */
  sessionId(ctx: Ctx): string
  /** The host's working directory. */
  cwd(ctx: Ctx): string
  /** Whether the host can paint UI right now. */
  canPaint(ctx: Ctx): boolean
  /** Paint the board. */
  paint(ctx: Ctx, lines: string[], crumb: string): void
  /** Remove the board. */
  clear(ctx: Ctx): void
  /** Tell the user something. */
  notify(ctx: Ctx, text: string, level: 'info' | 'warning' | 'error'): void
  /** Build the result that refuses to stop, with the reason. */
  refuseStop(reason: string): unknown
  /** Whether the stop event says the host already refused once. */
  stopAlreadyRefused(event: unknown): boolean
  /** The prompt behind a turn. */
  promptOf(event: unknown): string
  /** Build the result that injects a hidden context message. */
  inject(text: string): unknown
  /** Build the result that appends text to a tool result. */
  appendToolResult(event: unknown, text: string): unknown
  /** The npx spec to fall back to — the published version of this adapter. */
  readonly npxPin?: string
}

/** A finished bro invocation's result. */
export interface BroRunResult {
  code: number
  stdout: string
  stderr: string
}

/** What the driver exposes to a client adapter beyond the wiring. */
export interface BroDriver {
  /** Run a bro subcommand and capture its output. */
  run(args: string[], cwd: string): Promise<BroRunResult>
  /** The last board snapshot. */
  readonly board: BoardStatus | null
  /** The host's own extension API, passed through untouched. */
  readonly api: unknown
}

/**
 * Wire bro into a host. `api` is the host's own extension API — the
 * driver passes it through so the client can register commands and
 * tools without a second channel.
 */
export function createBroDriver<Ctx>(host: BroHostBinding<Ctx>, api: unknown): BroDriver {
  let resolved: Promise<Command | null> | undefined
  let board: BoardStatus | null = null

  /** Cached hydration text — primed on session start (the only window
   *  where the 20-40s probe cost overlaps the user's first prompt),
   *  then injected once into context and re-primed across compaction. */
  let hydration: Promise<string> | undefined
  let injected = false
  /** Set when the stop gate already refused this session — gates, not
   *  loops: the blocker goes back once, a later stop is let through. */
  let gated = false

  /** Resolve the CLI once. Probing costs a spawn even where bro is
   *  inert, so it stays lazy. */
  const command = (): Promise<Command | null> => {
    resolved ??= resolveCommand({ npxPin: host.npxPin })
    return resolved
  }

  /** Probe one bro hook. Fail-open: every failure is "no opinion". */
  const probe = async (
    event: string,
    payload: unknown,
    cwd: string,
    timeoutMs = HOOK_TIMEOUT_MS
  ): Promise<HookControl | null> => {
    if (!broEnabled(cwd)) {
      return null
    }
    const cmd = await command()
    return cmd === null ? null : callHook(cmd, event, payload, cwd, timeoutMs)
  }

  const paint = (ctx: Ctx): void => {
    if (!host.canPaint(ctx)) {
      return
    }
    if (board === null) {
      host.clear(ctx)
      return
    }
    host.paint(ctx, boardLines(board), statusCrumb(board))
  }

  const refreshBoard = async (ctx: Ctx): Promise<void> => {
    const cwd = host.cwd(ctx)
    if (!broEnabled(cwd)) {
      return
    }
    const cmd = await command()
    if (cmd === null) {
      return
    }
    board = await statusJson(cmd, cwd)
    paint(ctx)
  }

  /** Hydration runs once per session (re-primed on compaction); the
   *  answer is injected at the next turn start, not pushed into the
   *  transcript eagerly — the user may sit at the prompt for minutes. */
  const hydrate = (ctx: Ctx, event: 'session-start' | 'post-compaction'): void => {
    const cwd = host.cwd(ctx)
    const sessionId = host.sessionId(ctx)
    const started = probe(event, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS).then(
      contextOf
    )
    hydration = started
    injected = false
    // a failed probe is not the session's verdict — drop the cache entry
    // so the next turn deserves a retry rather than sticking on ''
    void started.then((text) => {
      if (hydration === started && text === '') {
        hydration = undefined
      }
    })
  }

  /** Register one handler if the host has that event. */
  const bind = (
    name: string | undefined,
    handler: (event: unknown, ctx: Ctx) => unknown
  ): void => {
    if (name === undefined) {
      return
    }
    host.on(name, handler)
  }

  bind(host.events.sessionStart, (_event, ctx) => {
    hydrate(ctx, 'session-start')
    void refreshBoard(ctx)
  })

  bind(host.events.sessionCompact, (_event, ctx) => {
    gated = false
    hydrate(ctx, 'post-compaction')
    void refreshBoard(ctx)
  })

  // pre-compact context is what must survive the summary — carry it into
  // the hydration cache so the post-compaction inject keeps it
  bind(host.events.sessionBeforeCompact, async (_event, ctx) => {
    const cwd = host.cwd(ctx)
    const text = contextOf(
      await probe('pre-compact', { session_id: host.sessionId(ctx) }, cwd, REHYDRATION_TIMEOUT_MS)
    )
    if (text === '') {
      return
    }
    const carry = text
    const prior = hydration ?? Promise.resolve('')
    hydration = prior.then((base) => (base === '' ? carry : `${base}\n\n${carry}`))
  })

  // The turn's entry point: bro's prompt-submit nudge and the cached
  // hydration ride one hidden message, so the transcript gains nothing
  // the user has to scroll past.
  bind(host.events.beforeAgentStart, async (event, ctx) => {
    const cwd = host.cwd(ctx)
    const sessionId = host.sessionId(ctx)
    const prompt = host.promptOf(event)
    const nudge = probe(
      'prompt-submit',
      { session_id: sessionId, prompt },
      cwd
    ).then(contextOf)

    const parts: string[] = []
    if (!injected && hydration !== undefined) {
      const text = (await hydration).trim()
      if (text !== '') {
        parts.push(text)
      }
      injected = true
    }
    const nudgeText = (await nudge).trim()
    if (nudgeText !== '') {
      parts.push(nudgeText)
    }
    if (parts.length === 0) {
      return undefined
    }
    return host.inject(parts.join('\n\n'))
  })

  // post-tool: the arming markers + nudges live in bro; the nudge text
  // appends to the tool result content
  bind(host.events.toolResult, async (event, ctx) => {
    const cwd = host.cwd(ctx)
    const tool = event as { toolName?: string; input?: unknown; isError?: boolean }
    const text = contextOf(
      await probe('post-tool', {
        session_id: host.sessionId(ctx),
        tool_name: tool.toolName ?? '',
        tool_input: tool.input ?? {},
        tool_response: { success: tool.isError !== true },
      }, cwd)
    )
    if (text === '') {
      return undefined
    }
    return host.appendToolResult(event, text)
  })

  // the stop gate: bro decides, the host refuses. The host's own
  // "already refused" flag goes back to bro so bro's one-shot rule
  // applies — the driver never loops the gate itself.
  bind(host.events.stop, async (event, ctx) => {
    const already = gated || host.stopAlreadyRefused(event)
    const control = await probe('stop', {
      session_id: host.sessionId(ctx),
      stop_hook_active: already,
    }, host.cwd(ctx))
    if (control?.decision !== 'block') {
      const hint = contextOf(control)
      if (hint !== '') {
        host.notify(ctx, hint, 'info')
      }
      return undefined
    }
    gated = true
    const reason = typeof control.reason === 'string' ? control.reason.trim() : ''
    void refreshBoard(ctx)
    return host.refuseStop(reason === '' ? 'unfinished bro work' : reason)
  })

  bind(host.events.turnEnd, (_event, ctx) => {
    void refreshBoard(ctx)
  })

  bind(host.events.sessionShutdown, (_event, ctx) => {
    host.clear(ctx)
  })

  /** Run a bro subcommand — resolve the CLI first, then hand off. */
  const run = async (args: string[], cwd: string): Promise<BroRunResult> =>
    runBro(await command(), args, cwd)

  return {
    get board() {
      return board
    },
    run,
    api,
  }
}

/** Run a bro subcommand and capture its output — the read side of the
 *  CLI, used by the client's own command and tools. */
async function runBro(
  command: Command | null,
  args: string[],
  cwd: string
): Promise<BroRunResult> {
  if (command === null) {
    return { code: 127, stdout: '', stderr: 'bro CLI not found' }
  }
  const { promise, resolve } = Promise.withResolvers<BroRunResult>()
  let child: ChildProcess
  try {
    child = spawn(command.cmd, [...command.args, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
  } catch {
    resolve({ code: 127, stdout: '', stderr: 'spawn failed' })
    return promise
  }
  let out = ''
  let err = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (out.length < 1 << 20) out += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    if (err.length < 1 << 20) err += chunk
  })
  child.on('error', () => resolve({ code: 127, stdout: '', stderr: 'spawn failed' }))
  child.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }))
  return promise
}
