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
import { createBoardPanel, type BoardPanelFactory } from './board-panel.ts'
import { broArgumentCompletions, type BroCompletion } from './completions.ts'
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

/** The board's widget key — one slot, owned by bro. */
export const BOARD_KEY = 'bro'

/** A hung CLI must not wedge the driver: `/bro`, `bro_status` and the
 *  board refresh are interactive reads, and a wedged dolt lock can
 *  stall them forever. The kill takes the detached process group
 *  down, so a dolt child dies with its parent. */
export const RUN_TIMEOUT_MS = 60_000

/** How long a failed CLI resolution stays cached before a retry —
 *  PATH, a local install or npx can appear mid-session, but
 *  re-probing the npx rung on every keystroke would be worse than
 *  the outage. */
export const RESOLVE_RETRY_MS = 60_000

/** The context shape this API lineage shares.
 *
 *  pi and omp are the same extension API lineage: the same `ctx.ui`,
 *  the same `ctx.mode`, the same `ctx.sessionManager`. Only the
 *  *vocabulary* differs — the event names and the stop refusal. */
export interface BroContext {
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
    setStatus(key: string, text: string | undefined): void
    setWidget(key: string, content: string[] | undefined): void
    /** Mount a keyboard-focused component (interactive TUI) — upstream
     *  `ExtensionUIContext.custom` (extensions/types.ts), the shape the
     *  board panel runs on. Optional: absent headless and on older
     *  hosts; callers must guard with `typeof === 'function'`. */
    custom?(factory: BoardPanelFactory, options?: { overlay?: boolean }): Promise<undefined>
  }
  cwd: string
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  sessionManager: { getSessionId(): string | undefined }
}

/** The event names this lineage shares. A host that spells one
 *  differently overrides it — pi's settle gate is not omp's stop. */
const LINEAGE_EVENTS = {
  sessionStart: 'session_start',
  sessionBeforeCompact: 'session_before_compact',
  sessionCompact: 'session_compact',
  beforeAgentStart: 'before_agent_start',
  toolResult: 'tool_result',
  turnEnd: 'turn_end',
  sessionShutdown: 'session_shutdown',
} as const

/** What a host must supply: the parts that are genuinely its own. */
export interface BroHostShape<Ctx extends BroContext> {
  /** The host's stop event. */
  stop: string
  /** Register a handler. */
  on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void
  /** Paint the board. */
  paint(ctx: Ctx, lines: string[], crumb: string): void
  /** Tell the user something. */
  notify(ctx: Ctx, text: string, level: 'info' | 'warning' | 'error'): void
  /** Build the result that refuses to stop, with the reason. */
  refuseStop(reason: string): unknown
  /** Whether the stop event says the host already refused once. */
  stopAlreadyRefused(event: unknown): boolean
  /** Whether this stop event is an abort/error the gate must not
   *  resurrect — pi's settle gate is the only host with outcomes. */
  stopAborted?(event: unknown): boolean
}

/**
 * Build a binding for a host in this lineage.
 *
 * Everything the lineage agrees on — the session id, the cwd, the paint
 * check, the message shapes, the event names — is filled in here. A
 * binding is left holding only what its host actually spells
 * differently, which is the whole point: a binding that re-copies the
 * lineage's shape is a binding that will drift.
 */
export function sharedBinding<Ctx extends BroContext>(
  host: BroHostShape<Ctx>
): BroHostBinding<Ctx> {
  return {
    events: { ...LINEAGE_EVENTS, stop: host.stop },
    on: host.on,
    sessionId(ctx) {
      return ctx.sessionManager.getSessionId() ?? ''
    },
    cwd(ctx) {
      return ctx.cwd
    },
    canPaint(ctx) {
      return ctx.mode === 'tui'
    },
    async mountPanel(ctx, factory) {
      const custom = ctx.ui.custom
      // the lineage's canPaint rule (mode === 'tui') plus the mount
      // itself — RPC hosts may report hasUI yet not mount components
      if (!ctx.hasUI || ctx.mode !== 'tui' || typeof custom !== 'function') {
        return false
      }
      try {
        await custom.call(ctx.ui, factory, { overlay: true })
        return true
      } catch {
        // mount rejected (older host, aborted flow) — the caller's
        // plain refresh keeps the command useful
        return false
      }
    },
    paint: host.paint,
    clear(ctx) {
      try {
        ctx.ui.setWidget(BOARD_KEY, undefined)
        ctx.ui.setStatus(BOARD_KEY, undefined)
      } catch {
        // a host that invalidated its context (pi session swap) makes
        // cleanup a no-op — an advisory clear is never worth a throw
      }
    },
    notify: host.notify,
    refuseStop: host.refuseStop,
    stopAlreadyRefused: host.stopAlreadyRefused,
    stopAborted: host.stopAborted,
    promptOf(event) {
      const turn = event as { prompt?: string }
      return typeof turn.prompt === 'string' ? turn.prompt : ''
    },
    inject(text) {
      return {
        message: {
          customType: 'bro-context',
          content: text,
          display: false,
        },
      }
    },
    appendToolResult(event, text) {
      const result = event as { content?: Array<{ type: 'text'; text: string }> }
      const content = Array.isArray(result.content) ? [...result.content] : []
      content.push({ type: 'text', text })
      return { content }
    },
  }
}

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
  /** Mount the board panel as a keyboard-focused component; resolves
   *  false when the host cannot mount one (headless, no `custom`). */
  mountPanel(ctx: Ctx, factory: BoardPanelFactory): Promise<boolean>
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
  /** Whether this stop event is an abort/error the gate must not
   *  resurrect — pi settles carry an outcome, and refusing an
   *  aborted turn would resume a turn the user already cancelled.
   *  Hosts without outcomes omit it. */
  stopAborted?(event: unknown): boolean
  /** The prompt behind a turn. */
  promptOf(event: unknown): string
  /** Build the result that injects a hidden context message. */
  inject(text: string): unknown
  /** Build the result that appends text to a tool result. */
  appendToolResult(event: unknown, text: string): unknown
  /** The npx spec to fall back to — the published version of this adapter. */
  readonly npxPin?: string
}

/** The host API surface the shared surfaces need.
 *
 *  pi and omp are the same extension API lineage — `registerCommand`,
 *  `registerTool` and `sendMessage` have the same shapes — so `/bro`
 *  and `bro_status` are written once, here, instead of copied into
 *  every binding. A copied command is a drifted command. */
export interface BroHostApi<Ctx = unknown> {
  registerCommand(
    name: string,
    options: {
      description?: string
      /** The slash dropdown's argument completer — both upstreams
       *  (omp's extensions/types.ts, pi's extensions/types.ts) carry
       *  the same hook; a host that predates it just ignores the
       *  field. */
      getArgumentCompletions?: (argumentPrefix: string) => BroCompletion[] | null
      handler: (args: string, ctx: Ctx) => Promise<void> | void
    }
  ): void
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: Ctx
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }): void
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void
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
  /** Refresh + repaint the board for a context — the repaint path a
   *  host-only settle/turn event can call. Resolves the current
   *  snapshot (null where bro is unavailable). */
  refresh(ctx: unknown): Promise<BoardStatus | null>
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
export function createBroDriver<Ctx>(host: BroHostBinding<Ctx>, api: BroHostApi<Ctx>): BroDriver {
  let board: BoardStatus | null = null
  /** Monotonic token — a refresh that finishes after a newer one
   *  started must not overwrite the newer snapshot. */
  let refreshSeq = 0

  /** Hydration text + the session it belongs to. Sessions can overlap
   *  (a replaced session's handler still pending while the new one
   *  starts), so the cache and the "already injected" claim are keyed
   *  by session id — one session's context never lands in another,
   *  and the claim is taken synchronously so two concurrent
   *  before-agent handlers cannot both inject. */
  let hydration: { sessionId: string; promise: Promise<string> } | undefined
  let hydrated: string | undefined
  /** Pre-compaction carry — kept apart from the hydration probe so a
   *  post-compaction re-probe cannot overwrite what must survive the
   *  summary. Consumed (cleared) by the next hydrate() that runs. */
  let carry: { sessionId: string; text: string } | undefined
  /** Set when the stop gate already refused this session — gates, not
   *  loops: the blocker goes back once per session, a later stop is
   *  let through, and a NEW session starts with a fresh gate (the
   *  flag dies with its session instead of leaking into the next). */
  let gatedSession: string | undefined

  /** Resolve the CLI once. Probing costs a spawn even where bro is
   *  inert, so it stays lazy. A *failed* resolution is not permanent:
   *  PATH, a local install or npx can appear mid-session, so a null
   *  answer expires after RESOLVE_RETRY_MS instead of poisoning the
   *  whole extension instance. */
  let resolved: Promise<Command | null> | undefined
  let resolvedFailedAt: number | undefined
  const command = (): Promise<Command | null> => {
    if (
      resolved !== undefined &&
      (resolvedFailedAt === undefined || Date.now() - resolvedFailedAt < RESOLVE_RETRY_MS)
    ) {
      return resolved
    }
    resolvedFailedAt = undefined
    resolved = resolveCommand({ npxPin: host.npxPin }).then((cmd) => {
      if (cmd === null) {
        resolvedFailedAt = Date.now()
      }
      return cmd
    })
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

  /** Re-probe the board and repaint. Fail-open: an unavailable bro
   *  leaves the last snapshot in place; resolves whatever is current. */
  const refreshBoard = async (ctx: Ctx): Promise<BoardStatus | null> => {
    const cwd = host.cwd(ctx)
    const seq = ++refreshSeq
    if (!broEnabled(cwd)) {
      // another repo's board must not leak into this session
      board = null
      paint(ctx)
      return board
    }
    const cmd = await command()
    if (cmd === null || seq !== refreshSeq) {
      return board
    }
    const next = await statusJson(cmd, cwd)
    // a newer refresh superseded this one while it was in flight —
    // the slower, older answer must not overwrite it
    if (seq !== refreshSeq) {
      return board
    }
    // fail-open: a failed probe is "no opinion", not "no board" — keep
    // the last usable snapshot instead of blanking the widget
    if (next !== null) {
      board = next
    }
    paint(ctx)
    return board
  }

  /** Hydration runs once per session (re-primed on compaction); the
   *  answer is injected at the next turn start, not pushed into the
   *  transcript eagerly — the user may sit at the prompt for minutes.
   *  A pre-compaction carry rides along: it was already shown to the
   *  model once, so it must survive the summary re-probe. */
  const hydrate = (ctx: Ctx, event: 'session-start' | 'post-compaction'): void => {
    const cwd = host.cwd(ctx)
    const sessionId = host.sessionId(ctx)
    const priorCarry = carry?.sessionId === sessionId ? carry.text : ''
    carry = undefined
    const started = probe(event, { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS)
      .then(contextOf)
      .then((text) => (priorCarry === '' ? text : text === '' ? priorCarry : `${priorCarry}\n\n${text}`))
    hydration = { sessionId, promise: started }
    // re-priming (compaction) earns a fresh inject for this session;
    // a different session's claim is untouched
    if (hydrated === sessionId) {
      hydrated = undefined
    }
    // a failed probe is not the session's verdict — drop the cache entry
    // so the next turn deserves a retry rather than sticking on ''
    void started
      .then((text) => {
        if (hydration?.promise === started && text === '') {
          hydration = undefined
        }
      })
      .catch(() => {})
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
    // a fresh session starts with a fresh gate — the prior session's
    // refusal must not skip this one's exit gate
    gatedSession = undefined
    hydrate(ctx, 'session-start')
    void refreshBoard(ctx).catch(() => {})
  })

  bind(host.events.sessionCompact, (_event, ctx) => {
    hydrate(ctx, 'post-compaction')
    void refreshBoard(ctx).catch(() => {})
  })

  // pre-compact context is what must survive the summary — park it in
  // the carry slot so the next hydrate() for the same session appends
  // it instead of the post-compaction probe overwriting it
  bind(host.events.sessionBeforeCompact, async (_event, ctx) => {
    const cwd = host.cwd(ctx)
    const sessionId = host.sessionId(ctx)
    const text = contextOf(
      await probe('pre-compact', { session_id: sessionId }, cwd, REHYDRATION_TIMEOUT_MS)
    )
    if (text === '') {
      return
    }
    carry = { sessionId, text }
    // if this session's hydration already ran (compaction beat the
    // probe), splice the carry into the live promise — the next inject
    // must still carry it
    const pending = hydration
    if (pending !== undefined && pending.sessionId === sessionId) {
      const merged = pending.promise.then((base) => (base === '' ? text : `${base}\n\n${text}`))
      hydration = { sessionId, promise: merged }
      carry = undefined
    }
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
    const pending = hydration
    if (pending !== undefined && hydrated !== sessionId && pending.sessionId === sessionId) {
      // claim synchronously, before the await — two concurrent
      // before-agent handlers must not both inject this text
      hydrated = sessionId
      const text = (await pending.promise).trim()
      if (text !== '') {
        parts.push(text)
      }
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
  const stopGate = async (
    event: unknown,
    ctx: Ctx,
    sessionId: string
  ): Promise<unknown> => {
    // an aborted or errored turn ends — the gate exists to keep
    // unfinished WORK in the session, never to resurrect a cancelled turn
    if (host.stopAborted?.(event) === true) {
      return undefined
    }
    const already = gatedSession === sessionId || host.stopAlreadyRefused(event)
    const control = await probe('stop', {
      session_id: sessionId,
      stop_hook_active: already,
    }, host.cwd(ctx))
    if (control?.decision !== 'block') {
      const hint = contextOf(control)
      if (hint !== '') {
        host.notify(ctx, hint, 'info')
      }
      return undefined
    }
    gatedSession = sessionId
    const reason = typeof control.reason === 'string' ? control.reason.trim() : ''
    void refreshBoard(ctx).catch(() => {})
    return host.refuseStop(reason === '' ? 'unfinished bro work' : reason)
  }

  /** In-flight stop probes by session id — two concurrent stops must
   *  not both run the probe and both block: the second awaits the
   *  first's verdict, by which point `already` is true and bro's
   *  one-shot rule lets it through. */
  const stopsInFlight = new Map<string, Promise<unknown>>()
  bind(host.events.stop, (event, ctx) => {
    const sessionId = host.sessionId(ctx)
    const inFlight = stopsInFlight.get(sessionId)
    if (inFlight !== undefined) {
      return inFlight
    }
    const run = stopGate(event, ctx, sessionId).finally(() => {
      stopsInFlight.delete(sessionId)
    })
    stopsInFlight.set(sessionId, run)
    return run
  })

  bind(host.events.turnEnd, (_event, ctx) => {
    void refreshBoard(ctx).catch(() => {})
  })

  bind(host.events.sessionShutdown, (_event, ctx) => {
    host.clear(ctx)
  })

  /** Run a bro subcommand — resolve the CLI first, then hand off. */
  const run = async (args: string[], cwd: string): Promise<BroRunResult> =>
    runBro(await command(), args, cwd)

  /** Bare `/bro`: mount the interactive board panel where the host can
   *  give a component keyboard focus — an overlay over the transcript,
   *  editor untouched (docs/tui.md). Headless, non-TUI modes and hosts
   *  without `custom` fall back to the plain refresh. */
  const openBoardPanel = async (ctx: Ctx): Promise<boolean> =>
    host.mountPanel(ctx, async (tui, theme, keybindings, done) => {
      // the factory runs only where the host is actually mounting —
      // probe first so the panel's first render has data
      if (board === null) {
        await refreshBoard(ctx).catch(() => {})
      }
      return createBoardPanel({
        host: { snapshot: () => board, refresh: () => refreshBoard(ctx) },
        done,
        theme,
        keybindings,
        tui,
      })
    })

  /** The shared surfaces. Bare `/bro` mounts the interactive board
   *  panel (a plain refresh where no UI can mount); `bro act|next|
   *  fleet|drill` is a thin passthrough reachable without leaving the
   *  editor, and `bro_status` hands the model the same board JSON the
   *  widget renders. Both are the same on every host, so both live
   *  here. */
  api.registerCommand('bro', {
    description: 'bro — interactive board (panel), or run `bro <args>` (act|next|fleet|drill|…)',
    getArgumentCompletions: broArgumentCompletions,
    async handler(args: string, ctx: Ctx) {
      const trimmed = args.trim()
      if (trimmed === '') {
        if (await openBoardPanel(ctx)) {
          return
        }
        // refresh + repaint — the old path spawned the CLI and threw
        // the answer away, so bare /bro never updated the widget
        await refreshBoard(ctx)
        host.notify(ctx, 'bro: board refreshed', 'info')
        return
      }
      const result = await run(trimmed.split(/\s+/), host.cwd(ctx))
      const text = (result.stdout || result.stderr).trim()
      if (result.code !== 0) {
        host.notify(ctx, `bro ${trimmed}: exit ${result.code}`, 'error')
        return
      }
      api.sendMessage(
        { customType: 'bro-output', content: `$ bro ${trimmed}\n${text}`, display: true },
        { triggerTurn: false }
      )
      // a state-changing command must not leave the widget and the
      // mode bridges on the pre-command snapshot until some unrelated
      // lifecycle event repaints
      await refreshBoard(ctx).catch(() => {})
    },
  })

  api.registerTool({
    name: 'bro_status',
    label: 'bro status',
    description:
      'Read the bro project board: in-progress beads, ready count, fleet agents, drill frame, branch/dirty state. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = await run(['status', '--json'], host.cwd(ctx))
      return {
        content: [
          {
            type: 'text' as const,
            text: result.code === 0 ? result.stdout : 'bro status unavailable',
          },
        ],
      }
    },
  })

  return {
    get board() {
      return board
    },
    run,
    refresh: (ctx: unknown) => refreshBoard(ctx as Ctx),
    api,
  }
}

/** Run a bro subcommand and capture its output — the read side of the
 *  CLI, used by the client's own command and tools. A hung CLI must
 *  not wedge the driver: the child gets RUN_TIMEOUT_MS and then the
 *  whole process group dies (it is detached, so -pid takes dolt
 *  descendants with it). */
async function runBro(
  command: Command | null,
  args: string[],
  cwd: string,
  timeoutMs = RUN_TIMEOUT_MS
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
  let settled = false
  const settle = (result: BroRunResult): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    resolve(result)
  }
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGKILL')
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      // already dead — the close handler settles
    }
    settle({ code: 1, stdout: out, stderr: `${err}\nbro CLI timed out after ${timeoutMs}ms`.trim() })
  }, timeoutMs)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (out.length < 1 << 20) out += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    if (err.length < 1 << 20) err += chunk
  })
  child.on('error', () => settle({ code: 127, stdout: '', stderr: 'spawn failed' }))
  child.on('close', (code) => settle({ code: code ?? 1, stdout: out, stderr: err }))
  return promise
}
