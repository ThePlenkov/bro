import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateExitGate } from './exit-gate.ts'
import type { PrActState } from './types.ts'

const open = (over: Partial<PrActState> = {}): PrActState => ({
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
  ...over,
})

describe('evaluateExitGate', () => {
  it('passes a clean open PR', () => {
    assert.equal(evaluateExitGate(open()).ok, true)
  })

  it('blocks on open threads and pending/failing checks', () => {
    const g = evaluateExitGate(open({ openThreads: 2, ciPending: 1, ciFailing: 1 }))
    assert.equal(g.ok, false)
    assert.deepEqual(g.blockers, [
      '2 unresolved review thread(s)',
      '1 pending check(s)',
      '1 failing check(s)',
    ])
  })

  it('blocks on pending but not failed AI reviewers', () => {
    assert.equal(evaluateExitGate(open({ reviewersPending: 1 })).ok, false)
    // a failed reviewer check is infra noise — its findings (if any)
    // arrive as threads, which block on their own
    const g = evaluateExitGate(open({ reviewersFailing: 2 }))
    assert.equal(g.ok, true)
    assert.equal(g.reviewers_failing, 2)
  })

  it('blocks on SAST findings, conflicts, drafts, unknown mergeability', () => {
    assert.equal(evaluateExitGate(open({ sastPending: 1 })).ok, false)
    assert.equal(evaluateExitGate(open({ sastUnknown: 1 })).ok, false)
    assert.equal(evaluateExitGate(open({ mergeable: 'CONFLICTING' })).ok, false)
    assert.equal(evaluateExitGate(open({ mergeable: 'UNKNOWN' })).ok, false)
    assert.equal(evaluateExitGate(open({ mergeState: 'BEHIND' })).ok, false)
    assert.equal(evaluateExitGate(open({ isDraft: true })).ok, false)
  })

  it('is not blocked by stale pending statuses on a merged PR', () => {
    const g = evaluateExitGate(
      open({ state: 'MERGED', sastPending: 1, reviewersPending: 1, mergeable: 'UNKNOWN' }),
    )
    assert.equal(g.ok, true)
    assert.deepEqual(g.blockers, [])
    // counts still surface — informational, not blocking
    assert.equal(g.sast_pending, 1)
  })

  it('is not blocked on a closed-unmerged PR either', () => {
    assert.equal(evaluateExitGate(open({ state: 'CLOSED', openThreads: 3 })).ok, true)
  })

  it('mandates debt-defer once fix rounds exceed the cap', () => {
    const g = evaluateExitGate(
      open({ openThreads: 2, fixRounds: 4, maxRounds: 3 })
    )
    assert.equal(g.ok, false)
    assert.match(g.blockers[0], /fix-round cap hit \(4>3\)/)
    assert.match(g.blockers[0], /defer the 2 remaining thread\(s\)/)
    // at/below the cap or cap disabled — plain thread blocker
    assert.match(
      evaluateExitGate(open({ openThreads: 1, fixRounds: 3, maxRounds: 3 })).blockers[0],
      /1 unresolved review thread/
    )
    assert.match(
      evaluateExitGate(open({ openThreads: 1, fixRounds: 9, maxRounds: 0 })).blockers[0],
      /1 unresolved review thread/
    )
    // no open threads → cap is moot
    assert.equal(evaluateExitGate(open({ fixRounds: 9, maxRounds: 3 })).ok, true)
  })
})
