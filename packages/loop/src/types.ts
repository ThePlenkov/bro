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
  /** `providers.<name>` — a configured provider routes the spawn through
   *  the shared facade (acp workers are headless; cli providers supply
   *  the command template) instead of expanding `agent`. Empty = the raw
   *  `agent` template lane. */
  provider: string
  /** `fleet.profiles.<name>` preset — fills provider/model/autoApprove
   *  piecewise for the provider lane. */
  profile: string
  /** Model override for the provider lane — meaningless on a raw
   *  template (the template carries its own flags). */
  model: string
  /** Optional shell command run once in the fresh worktree before the
   *  agent spawns (e.g. `npm install`). */
  bootstrap: string
  /** Minutes of output silence before a live loop agent surfaces as a
   *  check-in advisory (`bro watch`/`bro status`). Advisory only — the
   *  orchestrator decides; there is no agent wall-clock kill. */
  stallMin: number
  /** A spawn gone in under this never ran — broken dist/agent/env, not
   *  a bead outcome: park instead of reopening into a crash-burn
   *  (bro-sovl3). 0 = reopen on every no-PR exit (legacy). */
  crashExitMs: number
  /** Minutes the merge gate may stay pending before the item is parked. */
  mergeTimeoutMin: number
  /** Max review-fix respawns per bead — defaults to act.maxRounds. */
  fixRounds: number
  /** Max beads per `bro loop` run — 0 = until the queue is gated/idle. */
  maxItems: number
  /** Max open PRs the run's gate stack may hold — at cap pushes stop
   *  and only gate service runs until a merge frees a slot. 1 is the
   *  near-serial shape (spec bro-zsmwq). */
  maxOpen: number
  /** Estimated disk footprint of one open slot in MB — the worktree
   *  checkout plus bootstrap/agent litter (~350M observed for this
   *  repo's npm install). The disk floor prices every slot at this
   *  cost (spec bro-2spp7). */
  worktreeMb: number
  /** Disk floor in slot units — a push is admitted only while free
   *  disk covers `diskMinSlots × worktreeMb` on every filesystem the
   *  run writes to (worktree parent, tmpdir). 0 disables the
   *  watermark. */
  diskMinSlots: number
  /** Max beads one claim may clump into a single work item — one
   *  worktree, one worker, one PR closing them all (spec bro-nspj7).
   *  1 = solo claims only (legacy). Clumping binds on the lead's
   *  affinity key (spec/epic/area/path) and never reaches past
   *  batchMinPriority. */
  batch: number
  /** The lowest urgency allowed into a clump — a bead batches only
   *  when `priority >= batchMinPriority` (bd numbering: 3 = P3 nits,
   *  4 = P4 noise). Urgent work always claims solo. */
  batchMinPriority: number
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  agent: '',
  provider: '',
  profile: '',
  model: '',
  bootstrap: '',
  stallMin: 45,
  crashExitMs: 10_000,
  mergeTimeoutMin: 45,
  fixRounds: 3,
  maxItems: 0,
  maxOpen: 3,
  worktreeMb: 400,
  diskMinSlots: 2,
  batch: 1,
  batchMinPriority: 3,
}
