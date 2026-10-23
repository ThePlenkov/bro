/**
 * bro as an omp extension — the board on omp's TUI, plus the same
 * lifecycle mechanics the shell adapters carry, over omp's in-process
 * extension API.
 *
 * ## Why omp gets its own adapter
 *
 * omp is not pi. The extension *shape* is the same (`pi.on`,
 * `registerCommand`, `registerTool`), but the vocabulary is not, and
 * the differences are the interesting part:
 *
 *   - **omp has a native stop gate.** `session_stop` accepts
 *     `{ decision: "block", reason }` and re-fires with
 *     `stop_hook_active: true` — exactly bro's one-shot gate contract,
 *     with the host enforcing it. pi had to fake it with
 *     `agent_before_settle` plus a hand-rolled continuation, and
 *     opencode had to re-prompt as a synthetic turn. Here bro's
 *     `decision: "block"` maps straight onto the host's own slot, and
 *     the host's `stop_hook_active` flag goes straight back into bro's
 *     hook payload.
 *
 *   - **omp's modes are native.** Plan, Goal, Vibe, Prewalk and Advisor
 *     all exist in omp already. bro does not reimplement them — bro is
 *     the *state plane* they run over, not a second set of modes. The
 *     wiring below is deliberately thin: bro's durable state (beads,
 *     claims, PR gates) is injected into the session, and the modes
 *     keep their own semantics.
 *
 *   - **omp's widget slot takes plain strings.** `ctx.ui.setWidget`
 *     accepts `string[]`, which is all the board needs.
 *
 * ## The bro surfaces
 *
 *   board     `bro status --json` → ctx.ui.setWidget + setStatus,
 *             refreshed on session start, turn end and after a gate.
 *   hooks     omp lifecycle events → `bro hooks <event>` with the
 *             payload on stdin — the same contract hooks/run.sh and the
 *             other adapters speak. The control object on stdout is
 *             translated into omp's own result slots.
 *   /bro      the CLI without leaving the editor.
 *   bro_* tools  the board and the PR gate as model-callable reads.
 *
 * ## Fail-open
 *
 * The whole contract: the CLI resolves lazily (sibling dist → checkout
 * → PATH → npx pin), every spawn is async, and a missing bro or a
 * non-bro repo yields no widget, no context, no gate — never an error
 * thrown into omp.
 */
import { createBroDriver, type BroHostBinding } from './host.ts'
import { installModeBridges, type BoardSnapshot } from './omp-modes.ts'
import type { OmpApi, OmpContext } from './omp-api.ts'

/** The published version of this adapter — the npx fallback pin. The
 *  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = '@broject/bro@0.2.5'

/** The board's widget key — one slot, owned by bro. */
const BOARD_KEY = 'bro'

/**
 * The omp binding: the host's own shape, nothing else. Every
 * behavioral decision lives in the shared driver, so this file is the
 * whole of "what is different about omp". The API is captured in the
 * closure — a module-level variable would leak one session's host into
 * another's.
 */
function binding(pi: OmpApi): BroHostBinding<OmpContext> {
  return {
    events: {
      sessionStart: 'session_start',
      sessionBeforeCompact: 'session_before_compact',
      sessionCompact: 'session_compact',
      beforeAgentStart: 'before_agent_start',
      toolResult: 'tool_result',
      stop: 'session_stop',
      turnEnd: 'turn_end',
      sessionShutdown: 'session_shutdown',
    },
    npxPin: NPX_PIN,

    on(event, handler) {
      pi.on(event, handler)
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
      ctx.ui.setWidget(BOARD_KEY, lines)
      ctx.ui.setStatus(BOARD_KEY, crumb)
    },
    clear(ctx) {
      ctx.ui.setWidget(BOARD_KEY, undefined)
      ctx.ui.setStatus(BOARD_KEY, undefined)
    },
    notify(ctx, text, level) {
      ctx.ui.notify(text, level)
    },
    refuseStop(reason) {
      // omp's native stop refusal: the reason is handed back to the
      // model, which continues the turn with the blocker in hand.
      return { decision: 'block' as const, reason }
    },
    stopAlreadyRefused(event) {
      const stop = event as { stop_hook_active?: boolean }
      return stop.stop_hook_active === true
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

/** The extension entry point — omp calls this with its API. */
export default function broExtension(pi: OmpApi): void {
  const driver = createBroDriver(binding(pi), pi)

  /** The mode bridges — bro's durable state handed to omp's native Plan,
   *  Goal and Vibe modes. See omp-modes.ts for why bro adds state
   *  rather than a second implementation of each mode. */
  installModeBridges(pi, {
    board: () => driver.board as BoardSnapshot | null,
  })

  /** `/bro <args>` — the CLI without leaving the editor. Bare `/bro`
   *  repaints the board; a real subcommand runs it and drops stdout into
   *  the transcript as a visible custom message. */
  pi.registerCommand('bro', {
    description: 'bro — board refresh, or run `bro <args>` (act|next|fleet|drill|…)',
    async handler(args: string, ctx: OmpContext) {
      const trimmed = args.trim()
      if (trimmed === '') {
        void driver.run(['status', '--json'], ctx.cwd).catch(() => {})
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
   *  gets the same object the widget renders. */
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
 * plugins/omp/bro/bro.ts.
 */
export const adapter = { id: 'bro', kind: 'omp-extension' } as const // NOSONAR typescript:S7734 — the sentinel is a published marker, not a second entry point
