/**
 * Exit gate — the act loop's "can I stop?" as code instead of prompt text.
 * ok=false carries named blockers so an agent loop can decide, not guess.
 */
import type { ExitGate, PrActState } from './types.ts'

export function evaluateExitGate(state: PrActState): ExitGate {
  const blockers: string[] = []
  if (state.openThreads > 0) {
    blockers.push(`${state.openThreads} unresolved review thread(s)`)
  }
  if (state.ciPending > 0) {
    blockers.push(`${state.ciPending} pending/failing required check(s)`)
  }
  if (state.reviewersPending > 0) {
    blockers.push(`${state.reviewersPending} AI reviewer(s) still running — recheck`)
  }
  if (state.sastPending > 0) {
    blockers.push(`${state.sastPending} SAST finding(s)`)
  }
  if (state.sastUnknown > 0) {
    blockers.push(`${state.sastUnknown} SAST check(s) with unknown annotation status`)
  }
  // Mergeability is only meaningful while the PR is open — GitHub reports
  // UNKNOWN forever on merged/closed PRs.
  if (state.state === 'OPEN') {
    if (state.mergeable === 'CONFLICTING') {
      blockers.push('merge conflicts')
    }
    if (state.mergeable === 'UNKNOWN') {
      blockers.push('mergeability still computing — recheck')
    }
    if (state.isDraft) {
      blockers.push('PR is a draft')
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
    open_threads: state.openThreads,
    ci_pending: state.ciPending,
    reviewers_pending: state.reviewersPending,
    sast_pending: state.sastPending,
    sast_unknown: state.sastUnknown,
    is_draft: state.isDraft,
  }
}
