/**
 * Shared act test fixtures.
 *
 * The gate state shape is long, and two test files needed the same
 * "a clean open PR" fixture. One definition keeps them in step — a
 * field added to `PrActState` lands in both instead of one.
 */
import type { PrActState } from './types.ts'

/** A clean open PR — no blockers of any kind. */
export function openActState(over: Partial<PrActState> = {}): PrActState {
  return {
    pr: 1,
    url: '',
    headSha: 'a'.repeat(40),
    headRef: 'feat/x',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    openThreads: 0,
    threads: [],
    ciPending: 0,
    ciFailing: 0,
    reviewersPending: 0,
    reviewersFailing: 0,
    sastPending: 0,
    sastUnknown: 0,
    fixRounds: 0,
    maxRounds: 3,
    docsOnly: false,
    alerts: [],
    reopenedThreads: [],
    ...over,
  }
}
