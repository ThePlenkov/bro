/** Task-stack round-robin (spec bro-zsmwq) — the pure decision table a
 *  service pass applies to each gate-stack member. The caller owns the
 *  stack, the fetches, and the side effects; this module only maps one
 *  settled snapshot to the next action so the table is unit-testable
 *  without IO. `GateSnapshot` is deliberately structural — @broject/loop
 *  stays free of @broject/act imports. */

/** One member's gate as the last poll saw it — the act gate's verdict
 *  fields plus the few state fields the table reads. */
export interface GateSnapshot {
  /** PR state — 'OPEN', 'MERGED', 'CLOSED'. */
  state: string
  headSha: string
  /** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'. */
  mergeable: string
  /** 'BEHIND', 'CLEAN', … */
  mergeState: string
  openThreads: number
  /** The act loop's round counter (pushes since first review). */
  fixRounds: number
  /** Effective round cap — act.maxRounds, docs-tightened. */
  maxRounds: number
  /** evaluateExitGate's verdict. */
  ok: boolean
  blockers: string[]
  /** gatePending(state) — checks/reviewers running or mergeability
   *  still computing. */
  pending: boolean
}

/** The member's own clock — per-gate-entry deadline and consumed
 *  respawn budget, kept by the caller between polls. */
export interface MemberClock {
  /** Gate (re-)entry ms — a fix/rebase round resets it, an
   *  update-branch push does not. */
  since: number
  /** Agent respawns consumed on this member — fix and rebase rounds
   *  share the one `loop.fixRounds` bound. */
  rounds: number
  /** headSha the last updateBranch call pushed — a still-old head on
   *  the next poll means the update is still landing, wait. */
  updatedSha?: string
}

export type MemberAction =
  /** Externally merged — finalize without a merge call. */
  | { kind: 'land' }
  /** Gate green — merge + finalize. */
  | { kind: 'merge' }
  /** PR closed unmerged. */
  | { kind: 'closed' }
  /** Open threads — respawn the agent with the thread list. */
  | { kind: 'fix' }
  /** Conflicts — respawn the agent with a rebase order. */
  | { kind: 'rebase' }
  /** BEHIND sole blocker on a mergeable PR — push the update. */
  | { kind: 'update' }
  /** Still settling (or the update is still landing) — poll again. */
  | { kind: 'wait' }
  /** Settle out of the stack: timeout, exhausted budget, or a settled
   *  blocker the loop can't service. */
  | { kind: 'park'; why: string }

/** One settled snapshot → one action. Mirrors the waitForGate +
 *  driveGate semantics: non-pending blockers settle immediately (the
 *  deadline only bounds pending), threads preempt while fix rounds
 *  remain, BEHIND+mergeable self-heals via update-branch, conflicts
 *  earn a rebase round while the member still has respawn budget. */
export function memberAction(
  s: GateSnapshot,
  m: MemberClock,
  opts: { fixRounds: number; timeoutMs: number; now: number }
): MemberAction {
  if (s.state === 'MERGED') {
    return { kind: 'land' }
  }
  if (s.state === 'CLOSED') {
    return { kind: 'closed' }
  }
  if (s.ok) {
    return { kind: 'merge' }
  }
  const capHit = s.maxRounds > 0 && s.fixRounds > s.maxRounds
  if (s.openThreads > 0 && !capHit && m.rounds < opts.fixRounds) {
    return { kind: 'fix' }
  }
  // BEHIND as the only blocker on a mergeable PR self-heals — the
  // update pushes a new head and the gate recomputes. A still-old
  // headSha on this poll means the update is landing: keep waiting,
  // don't re-push — bounded by the member deadline like the old
  // waitForGate's (an update that never lands settles as the blocker).
  if (
    s.mergeState === 'BEHIND' &&
    s.mergeable === 'MERGEABLE' &&
    s.blockers.length === 1
  ) {
    if (s.headSha !== m.updatedSha) {
      return { kind: 'update' }
    }
    return opts.now - m.since >= opts.timeoutMs
      ? { kind: 'park', why: `blocked: ${s.blockers.join('; ')}` }
      : { kind: 'wait' }
  }
  if (s.mergeable === 'CONFLICTING' && m.rounds < opts.fixRounds) {
    return { kind: 'rebase' }
  }
  if (s.pending) {
    return opts.now - m.since >= opts.timeoutMs
      ? {
          kind: 'park',
          why: `gate still pending after ${Math.round(opts.timeoutMs / 60_000)}m`,
        }
      : { kind: 'wait' }
  }
  return { kind: 'park', why: `blocked: ${s.blockers.join('; ')}` }
}
