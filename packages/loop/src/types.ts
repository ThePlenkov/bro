/** `bro loop` — the autonomous backlog runner. bro owns the loop: claim
 *  the top ready bead → fresh worktree → spawn the configured agent →
 *  drive the PR gate → close → repeat. The agent only ever sees one
 *  bead's work order; scheduling, gates and bookkeeping stay here. */

/** A bead as `bd ready --json` reports it (subset the loop needs). */
export interface LoopBead {
  id: string
  title: string
  description?: string
  priority: number
  issue_type: string
}

/** `loop` config section — which agent to spawn and the budgets. */
export interface LoopConfig {
  /** Shell template for the agent invocation — `{promptFile}` is replaced
   *  with the work-order file path (e.g. `devin --prompt-file {promptFile}
   *  -p`, `claude -p "$(cat {promptFile})"`, `codex exec "$(cat
   *  {promptFile})"`). Empty = no agent configured. */
  agent: string
  /** Optional shell command run once in the fresh worktree before the
   *  agent spawns (e.g. `npm install`). */
  bootstrap: string
  /** Minutes a single agent spawn may run before it's killed. */
  agentTimeoutMin: number
  /** Minutes the merge gate may stay pending before the item is parked. */
  mergeTimeoutMin: number
  /** Max review-fix respawns per bead — defaults to act.maxRounds. */
  fixRounds: number
  /** Max beads per `bro loop` run — 0 = until the queue is gated/idle. */
  maxItems: number
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  agent: '',
  bootstrap: '',
  agentTimeoutMin: 45,
  mergeTimeoutMin: 45,
  fixRounds: 3,
  maxItems: 0,
}
