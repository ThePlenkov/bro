/**
 * Exit gate — the act loop's "can I stop?" as code instead of prompt text.
 * ok=false carries named blockers so an agent loop can decide, not guess.
 */
import type { ExitGate, PrActState } from './types.ts'

export function evaluateExitGate(state: PrActState): ExitGate {
  // the gate guards an open PR's merge readiness — on a merged/closed PR
  // stale pending statuses (e.g. a reviewer that never finished) are
  // noise, not blockers
  const base = {
    open_threads: state.openThreads,
    ci_pending: state.ciPending,
    reviewers_pending: state.reviewersPending,
    reviewers_failing: state.reviewersFailing,
    sast_pending: state.sastPending,
    sast_unknown: state.sastUnknown,
    is_draft: state.isDraft,
    fix_rounds: state.fixRounds,
    max_rounds: state.maxRounds,
  }
  if (state.state !== 'OPEN') {
    return { ok: true, blockers: [], ...base }
  }
  const blockers: string[] = []
  if (state.openThreads > 0) {
    if (state.maxRounds > 0 && state.fixRounds > state.maxRounds) {
      // bound the act loop: past the round cap, remaining threads defer to
      // debt beads (reply + resolve) instead of another inline-fix push
      blockers.push(
        `fix-round cap hit (${state.fixRounds}>${state.maxRounds}) — ` +
          `defer the ${state.openThreads} remaining thread(s) to debt beads and resolve, do not fix inline`
      )
    } else {
      blockers.push(`${state.openThreads} unresolved review thread(s)`)
    }
  }
  if (state.ciPending > 0) {
    blockers.push(`${state.ciPending} pending/failing check(s)`)
  }
  if (state.reviewersPending > 0) {
    blockers.push(`${state.reviewersPending} AI reviewer(s) still running — recheck`)
  }
  // a *failed* reviewer check is infrastructure (crash/quota/service
  // outage) — the reviewer's actual findings arrive as threads, which DO
  // block above. reviewersFailing stays in the report for visibility but
  // never holds the gate; pending reviewers still wait since they may
  // post findings.
  if (state.sastPending > 0) {
    blockers.push(`${state.sastPending} SAST finding(s)`)
  }
  if (state.sastUnknown > 0) {
    blockers.push(`${state.sastUnknown} SAST check(s) with unknown annotation status`)
  }
  if (state.mergeable === 'CONFLICTING') {
    blockers.push('merge conflicts')
  }
  if (state.mergeable === 'UNKNOWN') {
    blockers.push('mergeability still computing — recheck')
  }
  // BEHIND means the merge can't proceed without an update; BLOCKED is not
  // listed — required-review blocks are intentionally bypassed via --admin,
  // and UNSTABLE overlaps the all-checks ci_pending count
  if (state.mergeState === 'BEHIND') {
    blockers.push('branch is behind the base — update it')
  }
  if (state.isDraft) {
    blockers.push('PR is a draft')
  }
  return { ok: blockers.length === 0, blockers, ...base }
}
