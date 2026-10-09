import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memberAction,
  type GateSnapshot,
  type MemberClock,
} from './schedule.ts'

const NOW = 1_000_000

const snap = (over: Partial<GateSnapshot> = {}): GateSnapshot => ({
  state: 'OPEN',
  headSha: 'abc',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  openThreads: 0,
  fixRounds: 0,
  maxRounds: 0,
  ok: false,
  blockers: [],
  pending: false,
  ...over,
})

const clock = (over: Partial<MemberClock> = {}): MemberClock => ({
  since: NOW,
  rounds: 0,
  ...over,
})

const opts = (over: Partial<{ fixRounds: number; timeoutMs: number; now: number }> = {}) => ({
  fixRounds: 3,
  timeoutMs: 45 * 60_000,
  now: NOW,
  ...over,
})

describe('memberAction', () => {
  test('terminal PR states settle the member', () => {
    assert.equal(memberAction(snap({ state: 'MERGED', ok: true }), clock(), opts()).kind, 'land')
    assert.equal(memberAction(snap({ state: 'CLOSED' }), clock(), opts()).kind, 'closed')
  })

  test('a green gate merges', () => {
    assert.equal(memberAction(snap({ ok: true }), clock(), opts()).kind, 'merge')
  })

  test('a pending gate waits inside its budget', () => {
    const a = memberAction(
      snap({ pending: true, blockers: ['1 pending check(s)'] }),
      clock({ since: NOW - 1000 }),
      opts()
    )
    assert.equal(a.kind, 'wait')
  })

  test('a pending gate past its budget parks naming the timeout', () => {
    const a = memberAction(
      snap({ pending: true, blockers: ['1 pending check(s)'] }),
      clock({ since: NOW - 46 * 60_000 }),
      opts()
    )
    assert.deepEqual(a, { kind: 'park', why: 'gate still pending after 45m' })
  })

  test('a settled gate ignores the deadline — verdict now, not at timeout', () => {
    const a = memberAction(
      snap({ blockers: ['2 failing check(s)'] }),
      clock({ since: NOW - 90 * 60_000 }),
      opts()
    )
    assert.deepEqual(a, { kind: 'park', why: 'blocked: 2 failing check(s)' })
  })

  test('open threads with rounds left respawn the fixer', () => {
    const a = memberAction(
      snap({ openThreads: 2, blockers: ['2 unresolved review thread(s)'] }),
      clock({ rounds: 1 }),
      opts()
    )
    assert.equal(a.kind, 'fix')
  })

  test('threads preempt pending CI — the gate event is the preemption point', () => {
    const a = memberAction(
      snap({ openThreads: 1, pending: true, blockers: ['t', 'ci'] }),
      clock(),
      opts()
    )
    assert.equal(a.kind, 'fix')
  })

  test('threads with the member budget spent park instead of respawning', () => {
    const a = memberAction(
      snap({ openThreads: 1, blockers: ['1 unresolved review thread(s)'] }),
      clock({ rounds: 3 }),
      opts()
    )
    assert.equal(a.kind, 'park')
  })

  test('the act cap parks the member even with rounds left', () => {
    const a = memberAction(
      snap({ openThreads: 1, fixRounds: 4, maxRounds: 3, blockers: ['cap'] }),
      clock({ rounds: 0 }),
      opts()
    )
    assert.equal(a.kind, 'park')
  })

  test('BEHIND as sole blocker on a mergeable PR updates the branch', () => {
    const a = memberAction(
      snap({ mergeState: 'BEHIND', blockers: ['branch is behind the base — update it'] }),
      clock(),
      opts()
    )
    assert.equal(a.kind, 'update')
  })

  test('a still-old head after an update reads as landing — wait', () => {
    const a = memberAction(
      snap({ mergeState: 'BEHIND', headSha: 'old', blockers: ['behind'] }),
      clock({ updatedSha: 'old' }),
      opts()
    )
    assert.equal(a.kind, 'wait')
  })

  test('BEHIND beside another blocker does not update — it settles', () => {
    const a = memberAction(
      snap({
        mergeState: 'BEHIND',
        blockers: ['1 unresolved review thread(s)', 'behind'],
        openThreads: 1,
      }),
      clock({ rounds: 3 }),
      opts()
    )
    assert.equal(a.kind, 'park')
  })

  test('CONFLICTING earns a rebase round while budget remains', () => {
    const a = memberAction(
      snap({ mergeable: 'CONFLICTING', blockers: ['merge conflicts'] }),
      clock(),
      opts()
    )
    assert.equal(a.kind, 'rebase')
  })

  test('CONFLICTING past the budget parks with the blocker text', () => {
    const a = memberAction(
      snap({ mergeable: 'CONFLICTING', blockers: ['merge conflicts'] }),
      clock({ rounds: 3 }),
      opts()
    )
    assert.deepEqual(a, { kind: 'park', why: 'blocked: merge conflicts' })
  })
})
