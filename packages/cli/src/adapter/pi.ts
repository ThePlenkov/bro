// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro as a pi extension — the project board on pi's TUI, plus the same
 * lifecycle mechanics the shell adapters carry, over pi's in-process
 * extension API (spec: bro-1qpk.3).
 *
 * Pi loads this module with jiti (raw TS, no compile) and calls the
 * default-export factory with `ExtensionAPI`. Two surfaces come from
 * bro; none of bro's policy lives here:
 *
 *   board     `bro status --json` → ctx.ui.setWidget + setStatus,
 *             refreshed on session start, turn end and agent settle.
 *             The one-call aggregated read exists precisely so this
 *             widget never shells out N times per tick.
 *   hooks     pi lifecycle events → `bro hooks <event>` with the
 *             payload on stdin, the same contract hooks/run.sh and the
 *             opencode adapter speak. The control object on stdout is
 *             translated into pi's own result slots.
 *
 *   pi event                  → bro hook / surface
 *   session_start             → session-start  (hydrate + prime board)
 *   session_before_compact    → pre-compact    (context carried into the
 *                                              post-compaction inject)
 *   session_compact           → post-compaction (re-prime hydration)
 *   before_agent_start        → prompt-submit  (nudge + the cached
 *                                               hydration, one hidden message)
 *   tool_result               → post-tool      (arming + nudges; nudge
 *                                               text appended to content)
 *   agent_before_settle       → stop           (block → continue + the
 *                                               blocker as a visible
 *                                               custom_message entry —
 *                                               pi's real settle gate, no
 *                                               post-hoc re-prompt needed
 *                                               like opencode's)
 *
 * `tool_call` is deliberately unwired: it can only block, and bro's
 * `permission` plane answers approve/ask — neither maps to a block.
 * When the guard plane lands (bro guard spec) it slots in here.
 *
 * `/bro <args>` is a thin passthrough — `bro act|next|fleet|drill`
 * reachable without leaving the editor. The `bro_status` tool hands the
 * model the same board JSON the widget renders.
 *
 * Fail-open is the whole contract: the CLI resolves lazily (sibling
 * dist → checkout walk-up → PATH probe → npx pin), every spawn is async,
 * a missing bro or a non-bro repo yields no widget, no context, no gate
 * — never an error thrown into pi.
 *
 * One pi-specific hazard this file is built around: **ctx goes stale.**
 * A session replace/reload invalidates the old ExtensionContext — any
 * property read on it throws, and an async handler still holding one
 * crashes the host process. Handlers snapshot cwd/sessionId
 * synchronously at event time (see snapshot()) and every ui touch is
 * wrapped — a stale ctx mid-flight degrades to "no paint".
 */
import { createBroDriver, type BroHostBinding } from './host.ts'

// --- structural pi surface ----------------------------------------------
// Declared, never imported — pi loads this module at runtime and nobody
// typechecks it against @earendil-works/pi-coding-agent, so a dependency
// would drag pi's type tree into this repo for fidelity pi itself
// guarantees. Field names are verbatim; upstream is the only place they
// should change. (Same convention as opencode.ts.)

type Level = 'info' | 'warning' | 'error'

interface UIContext {
  notify(message: string, type?: Level): void
  setStatus(key: string, text: string | undefined): void
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: 'aboveEditor' | 'belowEditor' }
  ): void
}

interface SessionReader {
  getSessionId(): string | undefined
}

interface ExtContext {
  ui: UIContext
  cwd: string
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  sessionManager: SessionReader
}

interface BoundaryResult {
  entries?: Array<{
    type: 'custom_message'
    customType: string
    content: string
    display: boolean
  }>
  continue?: boolean
}

interface PiApi {
  on(event: string, handler: (event: never, ctx: ExtContext) => unknown): () => void
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtContext) => Promise<void> | void
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
      ctx: ExtContext
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }): void
  exec(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<ExecResult>
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  killed: boolean
}

/** The published version of this adapter — the npx fallback pin. The
 *  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = '@broject/bro@0.2.5'

/** The board's widget key — one slot, owned by bro. */
const BOARD_KEY = 'bro'

/**
 * The pi binding: the host's own shape, nothing else. Every behavioral
 * decision lives in the shared driver, so this file is the whole of
 * "what is different about pi".
 */
function binding(pi: PiApi): BroHostBinding<ExtContext> {
  return {
    events: {
      sessionStart: 'session_start',
      sessionBeforeCompact: 'session_before_compact',
      sessionCompact: 'session_compact',
      beforeAgentStart: 'before_agent_start',
      toolResult: 'tool_result',
      stop: 'agent_before_settle',
      turnEnd: 'turn_end',
      sessionShutdown: 'session_shutdown',
    },
    npxPin: NPX_PIN,

    on(event, handler) {
      pi.on(event as never, handler as never)
    },
    sessionId(ctx) {
      return ctx.sessionManager.getSessionId() ?? ''
    },
    cwd(ctx) {
      return ctx.cwd
    },
    canPaint(ctx) {
      return ctx.mode === 'tui'
    },
    paint(ctx, lines, crumb) {
      ctx.ui.setWidget(BOARD_KEY, lines, { placement: 'aboveEditor' })
      ctx.ui.setStatus(BOARD_KEY, crumb)
    },
    clear(ctx) {
      ctx.ui.setWidget(BOARD_KEY, undefined)
      ctx.ui.setStatus(BOARD_KEY, undefined)
    },
    notify(ctx, text, level) {
      try {
        ctx.ui.notify(text, level)
      } catch {
        // stale ctx — a hint is advisory, never worth a throw
      }
    },
    refuseStop(reason) {
      // pi has no native stop refusal: the settle gate continues the
      // turn with the blocker as a visible custom message.
      return {
        continue: true,
        entries: [
          {
            type: 'custom_message' as const,
            customType: 'bro-stop-gate',
            content: reason,
            display: true,
          },
        ],
      } satisfies BoundaryResult
    },
    stopAlreadyRefused() {
      // pi's settle gate has no stop_hook_active of its own — the
      // driver tracks the one-shot rule instead.
      return false
    },
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

/** The extension entry point — pi calls this with its API. */
export default function broExtension(pi: PiApi): void {
  const driver = createBroDriver(binding(pi), pi)

  // pi's board also refreshes when the agent settles — a settle can
  // follow a turn without a turn_end, and the board must not go stale.
  pi.on('agent_settled', (_e: never, ctx: ExtContext) => {
    void driver.run(['status', '--json'], ctx.cwd).catch(() => {})
  })

  /** `/bro <args>` — the CLI without leaving the editor. Bare `/bro`
   *  repaints the board; a real subcommand runs it and drops stdout into
   *  the transcript as a visible custom message. */
  pi.registerCommand('bro', {
    description: 'bro — board refresh, or run `bro <args>` (act|next|fleet|drill|…)',
    async handler(args: string, ctx: ExtContext) {
      const trimmed = args.trim()
      if (trimmed === '') {
        await driver.run(['status', '--json'], ctx.cwd)
        ctx.ui.notify('bro: board refreshed', 'info')
        return
      }
      const result = await driver.run(trimmed.split(/\s+/), ctx.cwd)
      const text = (result.stdout || result.stderr).trim()
      if (result.code !== 0) {
        ctx.ui.notify(`bro ${trimmed}: exit ${result.code}`, 'error')
        return
      }
      pi.sendMessage(
        { customType: 'bro-output', content: `$ bro ${trimmed}\n${text}`, display: true },
        { triggerTurn: false }
      )
    },
  })

  /** `bro_status` — the board JSON as a model-callable read. The model
   *  gets the same object the widget renders; schema is a plain empty
   *  object (a TypeBox-compatible literal — no dependency dragged in). */
  pi.registerTool({
    name: 'bro_status',
    label: 'bro status',
    description:
      'Read the bro project board: in-progress beads, ready count, fleet agents, drill frame, branch/dirty state. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = await driver.run(['status', '--json'], ctx.cwd)
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
}

/**
 * Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
 * foreign file holding this slot; the marker survives generation into
 * plugins/pi/bro/bro.ts.
 */
export const adapter = { id: 'bro', kind: 'pi-extension' } as const // NOSONAR typescript:S7734 — the sentinel is a published marker, not a second entry point
