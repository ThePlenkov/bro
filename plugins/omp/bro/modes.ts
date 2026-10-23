// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro's mode bridges for omp.
 *
 * ## The problem this solves
 *
 * omp already has Plan, Goal, Vibe, Prewalk and Advisor. bro has its own
 * versions of the same five ideas. Shipping both would mean two
 * competing implementations of "review the approach first" and "keep
 * working until the objective is met" — and the user would have to
 * guess which one the session is using.
 *
 * So bro does **not** reimplement omp's modes. bro contributes what
 * omp's modes cannot have: a **durable state plane** that survives the
 * session.
 *
 *   omp's mode            what it owns              what bro adds
 *   ─────────────────────  ────────────────────────  ─────────────────────
 *   Plan                   the draft + the review    the *spec* the plan
 *                                                    must answer, and the
 *                                                    claim it belongs to
 *   Goal                   the objective + budget    the bead, the drill
 *                                                    frame, and the judge
 *                                                    that says "met"
 *   Vibe                   the worker choreography   the *claims* — who owns
 *                                                    which bead, so two
 *                                                    workers never edit one
 *   Prewalk                the model handoff         the provider routing
 *                                                    that says which model
 *                                                    is fast *here*
 *   Advisor                the reviewing model        the review-debt ledger
 *                                                    — what this repo's
 *                                                    reviewers keep finding
 *
 * ## How the bridge works
 *
 * Every bridge reads one fact bro knows and hands it to omp in omp's
 * own vocabulary. None of them reimplements omp's mode.
 *
 * The bridge is deliberately **advisory**. omp's Plan Review and Goal
 * continuation are the user's decisions; bro's contribution is the
 * missing context, not a veto. The one exception is the stop gate —
 * that is bro's exit gate as code, and it belongs to the adapter's
 * `session_stop` handler, not here.
 */
import type { OmpApi, OmpContext } from './omp-api.ts'

/** The structural shape of the events this bridge reads. */
interface PlanReviewEvent {
  reviewId: string
  sessionId: string
  title: string
  planFilePath?: string
  planContent: string
}

interface GoalUpdatedEvent {
  goal: { objective?: string; text?: string } | null
}

interface BeforeSubagentSpawnEvent {
  agent: string
  invocationKind: 'task' | 'eval'
  modelRole?: string
  patterns: string[]
  spawnKey?: string
}

/** The board read — one aggregated call, never N shell-outs. */
export interface BoardSnapshot {
  branch?: string
  dirty?: number
  beads?: {
    inProgress?: Array<{ id?: string; title?: string }>
    readyTotal?: number
  }
  fleet?: {
    maxConcurrent?: number
    agents?: Array<{ id?: string; backend?: string; state?: string; step?: string }>
  }
  drill?: { frame?: { id?: string; title?: string; depth?: number } | null }
}

/** What the bridge needs from the adapter. */
export interface ModeBridgeSource {
  /** The last board snapshot, or null when bro is not installed. */
  board(): BoardSnapshot | null
}

/**
 * Install the bridges. Every handler is fail-open: a missing board, an
 * empty claim list, or a fact bro does not have means the bridge
 * contributes nothing rather than guessing.
 */
export function installModeBridges(pi: OmpApi, source: ModeBridgeSource): void {
  /**
   * **Plan mode.** omp's Plan Review is the user's decision point; bro
   * answers the question the reviewer would otherwise have to guess:
   * which bead does this plan belong to, and is that bead's spec
   * covered by the draft?
   *
   * The facts ride back through the review's own feedback channel — the
   * review surface stays omp's, and the user still chooses.
   */
  pi.on('plan_review_requested', (event: unknown) => {
    const review = event as PlanReviewEvent
    const board = source.board()
    if (board === null) {
      return undefined
    }
    const claims = board.beads?.inProgress ?? []
    if (claims.length === 0) {
      return undefined
    }
    const named = claims
      .map((b) => `${b.id ?? '?'}${b.title ? ` (${b.title})` : ''}`)
      .join(', ')
    return {
      additionalContext: `bro: ${claims.length} bead(s) in flight — ${named}. The plan must answer the claimed bead's spec; check it with \`bro spec check\`.`,
    }
  })

  /**
   * **Goal mode.** bro's goal is a *judged* condition; omp's is a
   * budgeted objective. The bridge names the bead the objective
   * belongs to, so the work is claimed and bro's exit gate can judge
   * it when the objective claims to be met.
   */
  pi.on('goal_updated', (event: unknown) => {
    const update = event as GoalUpdatedEvent
    if (update.goal === null) {
      return undefined
    }
    const objective = update.goal.objective ?? update.goal.text ?? ''
    if (objective === '') {
      return undefined
    }
    const board = source.board()
    const drill = board?.drill?.frame
    const scope =
      drill === undefined || drill === null
        ? ''
        : `bro scope: drill frame ${drill.id ?? '?'} — ${drill.title ?? '(untitled)'}. `
    return {
      additionalContext: `${scope}bro: claim a bead for this objective (\`bro flow next\`) so the exit gate can judge it; \`bro work goal\` carries the condition across sessions.`,
    }
  })

  /**
   * **Vibe mode / subagents.** Two workers must never edit one unit of
   * work. omp's `before_subagent_spawn` is the seam: bro can see the
   * claim list before a worker starts.
   */
  pi.on('before_subagent_spawn', (event: unknown) => {
    const spawn = event as BeforeSubagentSpawnEvent
    const board = source.board()
    if (board === null) {
      return undefined
    }
    const running = (board.fleet?.agents ?? []).filter((a) => a.state === 'running')
    if (running.length === 0) {
      return undefined
    }
    const ids = running.map((a) => a.id ?? '?')
    return {
      additionalContext: `bro: ${running.length} worker(s) already running (${ids.join(', ')}) — claim a bead before editing, so two workers never touch one unit of work.`,
    }
  })
}
