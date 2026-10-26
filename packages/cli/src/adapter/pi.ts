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
import {
  BOARD_KEY,
  createBroDriver,
  sharedBinding,
  type BroContext,
  type BroHostBinding,
} from './host.ts';

// --- structural pi surface ----------------------------------------------
// Declared, never imported — pi loads this module at runtime and nobody
// typechecks it against @earendil-works/pi-coding-agent, so a dependency
// would drag pi's type tree into this repo for fidelity pi itself
// guarantees. Field names are verbatim; upstream is the only place they
// should change. (Same convention as opencode.ts.)

type Level = 'info' | 'warning' | 'error';

interface UIContext {
  notify(message: string, type?: Level): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: 'aboveEditor' | 'belowEditor' }
  ): void;
}

interface SessionReader {
  getSessionId(): string | undefined;
}

// the lineage's context shape, with pi's one addition: setWidget takes a
// placement option
interface ExtContext extends BroContext {
  ui: UIContext;
  sessionManager: SessionReader;
}

interface BoundaryResult {
  entries?: Array<{
    type: 'custom_message';
    customType: string;
    content: string;
    display: boolean;
  }>;
  continue?: boolean;
}

interface PiApi {
  on(event: string, handler: (event: unknown, ctx: ExtContext) => unknown): () => void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtContext) => Promise<void>;
    }
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtContext
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
  }): void;
  exec(
    command: string,
    args: string[],
    options?: { timeout?: number; cwd?: string }
  ): Promise<ExecResult>;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** The published version of this adapter — the npx fallback pin. The
 *  pin is rewritten by gen-plugins on every gen/release run. */
const NPX_PIN = '@broject/bro@0.2.5';

/**
 * The pi binding: the host's own shape, nothing else. Every behavioral
 * decision lives in the shared driver, so this file is the whole of
 * "what is different about pi".
 */
function binding(pi: PiApi): BroHostBinding<ExtContext> {
  return {
    ...sharedBinding<ExtContext>({
      stop: 'agent_before_settle',
      on(event, handler) {
        pi.on(event as never, handler as never);
      },
      notify(ctx, text, level) {
        try {
          ctx.ui.notify(text, level);
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
        } satisfies BoundaryResult;
      },
      stopAlreadyRefused() {
        // pi's settle gate has no stop_hook_active of its own — the
        // driver tracks the one-shot rule instead.
        return false;
      },
      stopAborted(event) {
        // an aborted or errored settle must end, not be resumed by
        // the gate's custom-message continuation
        const settle = event as { outcome?: string };
        const outcome = settle.outcome;
        return outcome === 'aborted' || outcome === 'error';
      },
      paint(ctx, lines, _crumb) {
        try {
          // One compact line is enough — the 5-line board widget plus
          // the status crumb doubled up the chrome. Keep the summary
          // line (the informative one) as the single widget and drop the
          // redundant bottom crumb.
          let one: string[] | undefined;
          if (lines.length > 0) {
            const links = lines
              .slice(1)
              .map(l => (l.match(/\[#\d+\]\([^)]+\)/) ?? [])[0])
              .filter((x): x is string => typeof x === 'string');
            const head = links.length > 0 ? `${lines[0]}  ${links.join(' ')}` : lines[0];
            one = [head];
          }
          ctx.ui.setWidget(BOARD_KEY, one, { placement: 'aboveEditor' });
          ctx.ui.setStatus(BOARD_KEY, undefined);
        } catch {
          // pi invalidates the ctx on session replacement — a stale
          // widget paint is advisory, never worth a throw
        }
      },
    }),
    npxPin: NPX_PIN,
  };
}

/** The extension entry point — pi calls this with its API. */
export default function broExtension(pi: PiApi): void {
  const driver = createBroDriver(binding(pi), pi);

  // pi's board also refreshes when the agent settles — a settle can
  // follow a turn without a turn_end, and the board must not go stale.
  // driver.refresh repaints; driver.run alone spawned the CLI and
  // discarded the answer, leaving the widget stale.
  pi.on('agent_settled', (_e: unknown, ctx: ExtContext) => {
    void driver.refresh(ctx).catch(() => {});
  });
}

/**
 * Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
 * foreign file holding this slot; the marker survives generation into
 * plugins/pi/bro/bro.ts.
 */
export const adapter = { id: 'bro', kind: 'pi-extension' } as const; // NOSONAR typescript:S7734 — the sentinel is a published marker, not a second entry point
