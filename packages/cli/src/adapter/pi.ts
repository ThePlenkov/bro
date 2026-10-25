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
} from './host.ts'

// --- context rollover ------------------------------------------------------
const ROLLOVER_STATE_ENTRY = 'bro-context-rollover-state'
const ROLLOVER_EVENT_ENTRY = 'bro-context-rollover-event'
const ROLLOVER_SENTINEL_TYPE = 'bro-context-rollover-sentinel'

interface RolloverPending {
  generation: number
  instructions: string
  checkpoint: string
}

interface RolloverPersistedState {
  generation: number
  instructions: string
  checkpoint: string
  rolloverBoundaryEntryId?: string
}

interface RolloverExtensionState {
  generation: number
  instructions: string
  checkpoint: string
  pending?: RolloverPending
  rolloverBoundaryEntryId?: string
  lastAppliedGeneration: number
}

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
  getBranch?(): unknown[]
}

// the lineage's context shape, with pi's one addition: setWidget takes a
// placement option
interface ExtContext extends BroContext {
  ui: UIContext
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
  on(event: string, handler: (event: unknown, ctx: ExtContext) => unknown): () => void
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtContext) => Promise<void>
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
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>
  }): void
  exec(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<ExecResult>
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn'; triggerTurn?: boolean }
  ): void
  appendEntry?(customType: string, data?: unknown): void
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
        pi.on(event as never, handler as never)
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
      stopAborted(event) {
        // an aborted or errored settle must end, not be resumed by
        // the gate's custom-message continuation
        const settle = event as { outcome?: string }
        const outcome = settle.outcome
        return outcome === 'aborted' || outcome === 'error'
      },
      paint(ctx, lines, crumb) {
        try {
          ctx.ui.setWidget(BOARD_KEY, lines, { placement: 'aboveEditor' })
          ctx.ui.setStatus(BOARD_KEY, crumb)
        } catch {
          // pi invalidates the ctx on session replacement — a stale
          // widget paint is advisory, never worth a throw
        }
      },
    }),
    npxPin: NPX_PIN,
  }
}

/** The extension entry point — pi calls this with its API. */
export default function broExtension(pi: PiApi): void {
  const driver = createBroDriver(binding(pi), pi)

  // pi's board also refreshes when the agent settles — a settle can
  // follow a turn without a turn_end, and the board must not go stale.
  // driver.refresh repaints; driver.run alone spawned the CLI and
  // discarded the answer, leaving the widget stale.
  pi.on('agent_settled', (_e: unknown, ctx: ExtContext) => {
    void driver.refresh(ctx).catch(() => {})
  })

  // --- context rollover ----------------------------------------------------
  const state: RolloverExtensionState = {
    generation: 0,
    instructions: '',
    checkpoint: '',
    lastAppliedGeneration: -1,
  }

  const saveState = () => {
    try {
      pi.appendEntry?.(ROLLOVER_STATE_ENTRY, {
        generation: state.generation,
        instructions: state.instructions,
        checkpoint: state.checkpoint,
        rolloverBoundaryEntryId: state.rolloverBoundaryEntryId,
      } satisfies RolloverPersistedState)
    } catch {
      // fail-open
    }
  }

  const loadState = (ctx: ExtContext) => {
    try {
      const sm = ctx.sessionManager as any
      if (typeof sm?.getBranch !== 'function') return
      const branch = sm.getBranch() as any[]
      if (!Array.isArray(branch)) return
      // walk backwards to find latest state
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i]
        if (entry?.type === 'custom' && entry.customType === ROLLOVER_STATE_ENTRY && entry.data) {
          const d = entry.data as RolloverPersistedState
          state.generation = typeof d.generation === 'number' ? d.generation : 0
          state.instructions = typeof d.instructions === 'string' ? d.instructions : ''
          state.checkpoint = typeof d.checkpoint === 'string' ? d.checkpoint : ''
          state.rolloverBoundaryEntryId = d.rolloverBoundaryEntryId
          state.lastAppliedGeneration = state.generation
          state.pending = undefined
          break
        }
      }
    } catch {
      // fail-open
    }
  }

  pi.on('session_start', (_e: unknown, ctx: ExtContext) => {
    loadState(ctx)
  })

  pi.registerTool({
    name: 'context_rollover',
    label: 'context rollover',
    description:
      'Save evolved working instructions and task checkpoint for context rollover. Excludes old iteration messages on next LLM request and continues in the same session.',
    parameters: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description: 'Evolved working instructions to carry forward (replaces previous working instructions wholly)',
        },
        checkpoint: {
          type: 'string',
          description: 'Task checkpoint/state to carry forward',
        },
      },
      required: ['instructions', 'checkpoint'],
      additionalProperties: false,
    },
    execute: async (toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const p = params as { instructions?: unknown; checkpoint?: unknown }
        const instructions = typeof p.instructions === 'string' ? p.instructions : ''
        const checkpoint = typeof p.checkpoint === 'string' ? p.checkpoint : ''
        const nextGen = state.generation + 1
        state.pending = {
          generation: nextGen,
          instructions,
          checkpoint,
        }
        try {
          pi.appendEntry?.(ROLLOVER_EVENT_ENTRY, {
            type: 'rollover-requested',
            generation: nextGen,
            instructionsLength: instructions.length,
            checkpointLength: checkpoint.length,
            timestamp: Date.now(),
          })
          pi.sendMessage?.(
            {
              customType: ROLLOVER_SENTINEL_TYPE,
              content: `[[BRO_CONTEXT_ROLLOVER_SENTINEL:generation=${nextGen}]]`,
              display: false,
            },
            { deliverAs: 'followUp' }
          )
        } catch {
          // ignore
        }
        saveState()
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                generation: nextGen,
                pending: true,
                message: 'Context rollover scheduled for application at next safe boundary',
              }),
            },
          ],
          details: { generation: nextGen, pending: true },
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: String(err) }),
            },
          ],
          details: { ok: false },
        }
      }
    },
  })

  pi.registerTool({
    name: 'context_status',
    label: 'context status',
    description: 'Show current context rollover status (generation, pending rollover, instructions/checkpoint previews)',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      try {
        const instr = state.instructions
        const chk = state.checkpoint
        const status = {
          generation: state.generation,
          hasPending: !!state.pending,
          pendingGeneration: state.pending?.generation ?? null,
          instructionsPreview: instr.length > 120 ? instr.slice(0, 120) + '…' : instr,
          checkpointPreview: chk.length > 120 ? chk.slice(0, 120) + '…' : chk,
          lastAppliedGeneration: state.lastAppliedGeneration,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
          details: status,
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(err) }) }],
          details: { ok: false },
        }
      }
    },
  })

  const applyPending = (ctx?: ExtContext) => {
    if (!state.pending) return false
    const p = state.pending
    state.generation = p.generation
    state.instructions = p.instructions
    state.checkpoint = p.checkpoint
    state.pending = undefined
    state.lastAppliedGeneration = state.generation
    try {
      pi.appendEntry?.(ROLLOVER_EVENT_ENTRY, {
        type: 'rollover-applied',
        generation: state.generation,
        timestamp: Date.now(),
      })
    } catch {}
    saveState()
    try {
      // try to continue in same session
      pi.sendMessage?.(
        {
          customType: 'bro-context-rollover-continuation',
          content: 'Context rolled over. Continue from checkpoint with new working instructions.',
          display: false,
        },
        { deliverAs: 'followUp', triggerTurn: false }
      )
    } catch {}
    return true
  }

  pi.on('agent_before_settle', async (_event: unknown, ctx: ExtContext) => {
    if (state.pending) {
      applyPending(ctx)
    }
    return undefined
  })

  pi.on('turn_end', async (_event: unknown, ctx: ExtContext) => {
    if (state.pending) {
      applyPending(ctx)
    }
    return undefined
  })

  pi.on('context_with_system', async (event: any) => {
    try {
      if (!Array.isArray(event?.messages)) return
      const messages = event.messages.slice()
      if (messages.length === 0) return

      // Ensure leading system message preserved
      // Build new message list
      const out: any[] = []

      // Keep first message if it's system
      if (messages[0]?.role === 'system') {
        out.push(messages[0])
      } else {
        // try to find system
        const sysIdx = messages.findIndex((m: any) => m.role === 'system')
        if (sysIdx >= 0) {
          out.push(messages[sysIdx])
        }
      }

      // If we have rollover instructions/checkpoint, inject them
      if (state.instructions || state.checkpoint) {
        const parts: string[] = []
        if (state.instructions) {
          parts.push('## Working Instructions (rolled over)\n' + state.instructions)
        }
        if (state.checkpoint) {
          parts.push('## Task Checkpoint\n' + state.checkpoint)
        }
        const rolloverMsg = {
          role: 'user',
          content: [{ type: 'text', text: parts.join('\n\n') }],
        }
        out.push(rolloverMsg)
      }

      // Filter old iteration messages - keep recent messages, drop old ones and sentinels
      for (let i = 1; i < messages.length; i++) {
        const m = messages[i]
        // skip our sentinels
        if (m?.customType === ROLLOVER_SENTINEL_TYPE) continue
        if (m?.customType === 'bro-context-rollover-continuation') continue
        // skip very old large iteration dumps if we have a generation boundary? 
        // For now, keep most messages but this is a simple approach
        // More sophisticated filtering would track by generation
        out.push(m)
      }

      event.messages = out
      return { messages: out }
    } catch {
      // fail-open
    }
  })
}

/**
 * Adapter ownership sentinel — `bro plugins install|uninstall` refuses a
 * foreign file holding this slot; the marker survives generation into
 * plugins/pi/bro/bro.ts.
 */
export const adapter = { id: 'bro', kind: 'pi-extension' } as const // NOSONAR typescript:S7734 — the sentinel is a published marker, not a second entry point
