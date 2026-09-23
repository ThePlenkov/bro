import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateExitGate } from './exit-gate.ts'
import type { PrActState } from './types.ts'
import { gatePending, waitForGate } from './wait.ts'

const open = (over: Partial<PrActState> = {}): PrActState => ({
  pr: 1,
  headRef: 'x',
  headSha: 'abc',
  url: '',
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  isDraft: false,
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

const fetcher = (states: PrActState[]) => {
  let i = 0
  return async () => {
    const state = states[Math.min(i, states.length - 1)]!
    i += 1
    return { state, gate: evaluateExitGate(state) }
  }
}

test('gatePending: only pending signals keep waiting', () => {
  assert.equal(gatePending(open({ ciPending: 1 })), true)
  assert.equal(gatePending(open({ reviewersPending: 1 })), true)
  assert.equal(gatePending(open({ mergeable: 'UNKNOWN' })), true)
  assert.equal(gatePending(open()), false)
  assert.equal(gatePending(open({ openThreads: 3 })), false)
  assert.equal(gatePending(open({ state: 'MERGED', ciPending: 1 })), false)
})

test('waitForGate settles when the gate is green', async () => {
  const res = await waitForGate(fetcher([open({ ciPending: 1 }), open()]), {
    intervalMs: 0,
  })
  assert.equal(res.gate.ok, true)
  assert.equal(res.timedOut, false)
  assert.equal(res.polls, 2)
})

test('waitForGate settles on blockers without waiting them out', async () => {
  const res = await waitForGate(
    fetcher([open({ openThreads: 2, ciPending: 1 }), open({ openThreads: 2 })]),
    { intervalMs: 0 },
  )
  assert.equal(res.gate.ok, false)
  assert.equal(res.state.openThreads, 2)
  assert.equal(res.polls, 2)
})

test('a failing check settles immediately — not waited out', async () => {
  const res = await waitForGate(fetcher([open({ ciFailing: 1 })]), {
    intervalMs: 0,
  })
  assert.equal(res.gate.ok, false)
  assert.equal(res.timedOut, false)
  assert.equal(res.polls, 1)
})

test('transient fetch errors retry; persistent ones throw', async () => {
  let calls = 0
  const flaky = async () => {
    calls += 1
    if (calls < 3) {
      throw new Error('gh blip')
    }
    const state = open()
    return { state, gate: evaluateExitGate(state) }
  }
  const res = await waitForGate(flaky, { intervalMs: 0 })
  assert.equal(res.gate.ok, true)
  assert.equal(calls, 3)

  await assert.rejects(
    waitForGate(
      async () => {
        throw new Error('gh down')
      },
      { intervalMs: 0, maxFetchErrors: 2 },
    ),
  )
})

test('waitForGate times out on never-settling pending', async () => {
  const res = await waitForGate(fetcher([open({ reviewersPending: 1 })]), {
    intervalMs: 0,
    timeoutMs: 0,
  })
  assert.equal(res.timedOut, true)
  assert.equal(res.polls, 1)
})

test('BEHIND triggers updateBranch and keeps waiting on success', async () => {
  let updates = 0
  const res = await waitForGate(
    fetcher([
      open({ mergeState: 'BEHIND', headSha: 'a1' }),
      open({ mergeable: 'UNKNOWN' }), // update landed — mergeability recomputing
      open({ headSha: 'b2' }),
    ]),
    {
      intervalMs: 0,
      updateBranch: (s) => {
        updates += 1
        assert.equal(s.headSha, 'a1')
        return true
      },
    }
  )
  assert.equal(updates, 1)
  assert.equal(res.gate.ok, true)
  assert.equal(res.polls, 3)
})

test('BEHIND settles when updateBranch refuses or conflicts exist', async () => {
  const refused = await waitForGate(fetcher([open({ mergeState: 'BEHIND' })]), {
    intervalMs: 0,
    updateBranch: () => false,
  })
  assert.equal(refused.gate.ok, false)
  assert.equal(refused.polls, 1)

  // CONFLICTING is a human job — no update attempt even when offered
  let called = false
  const conflicted = await waitForGate(
    fetcher([open({ mergeState: 'BEHIND', mergeable: 'CONFLICTING' })]),
    { intervalMs: 0, updateBranch: () => ((called = true), true) }
  )
  assert.equal(called, false)
  assert.equal(conflicted.gate.ok, false)
})
