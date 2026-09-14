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
  if (state.sastPending > 0) {
    blockers.push(`${state.sastPending} SAST finding(s)`)
  }
  if (state.mergeable === 'CONFLICTING') {
    blockers.push('merge conflicts')
  }
  return {
    ok: blockers.length === 0,
    blockers,
    open_threads: state.openThreads,
    ci_pending: state.ciPending,
    sast_pending: state.sastPending,
    sast_unknown: state.sastUnknown,
    is_draft: state.isDraft,
  }
}
