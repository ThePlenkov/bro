import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  CheckInfo,
  PrMeta,
  PrTarget,
  ReviewFacade,
  ReviewThread,
} from '@broject/core'
import type { CheckHistory } from './check-history.ts'
import { fetchPrActState } from './state.ts'

const SHA = 'a'.repeat(40)
const target: PrTarget = { repo: 'o/r', pr: 7 }

const meta: PrMeta = {
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/7',
  headSha: SHA,
  headRef: 'feat/x',
  baseRef: 'main',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
}

const check = (name: string, bucket: string): CheckInfo => ({
  name,
  state: bucket === 'fail' ? 'FAILURE' : bucket === 'pending' ? 'PENDING' : 'SUCCESS',
  bucket,
})

const thread = (author: string, createdAt: string): ReviewThread => ({
  id: `t-${author}-${createdAt}`,
  resolved: false,
  outdated: false,
  comment: { author, bot: true, path: 'x.ts', line: 1, body: 'n', createdAt },
})

function fakeRev(checks: CheckInfo[], threads: ReviewThread[]): ReviewFacade {
  return {
    prMeta: () => meta,
    reviewThreads: async () => threads,
    checks: () => checks,
    checkAnnotations: () => new Map(),
    reviewedShas: () => [SHA],
  } as unknown as ReviewFacade
}

/** In-memory history with a preset streak — state.ts reads only the
 *  interface, so tests pin the streak directly. */
function memHistory(streak: number): CheckHistory & { recorded: string[] } {
  const recorded: string[] = []
  return {
    recorded,
    record: (o) => {
      recorded.push(`${o.name}@${o.sha.slice(0, 7)}=${o.bucket}`)
    },
    consecutiveFailures: () => streak,
  }
}

const fresh = new Date().toISOString()
const stale = new Date(Date.now() - 30 * 86_400_000).toISOString()

describe('fetchPrActState — conditional ignoreChecks', () => {
  const rules = [{ name: 'kilo', consecutiveFailures: 3, threadWindowDays: 7 }]

  test('non-matching checks pass through untouched', async () => {
    const s = await fetchPrActState(fakeRev([check('build', 'fail')], []), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    })
    assert.equal(s.ciFailing, 1)
    assert.deepEqual(s.alerts, [])
  })

  test('a pending ignored check stays silently ignored', async () => {
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'pending')], []), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(0),
    })
    assert.equal(s.reviewersPending, 0)
    assert.deepEqual(s.alerts, [])
  })

  test('failing with no thread activity alerts — silent reviewer', async () => {
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], []), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    })
    // the check stays out of the gate…
    assert.equal(s.ciFailing, 0)
    assert.equal(s.reviewersFailing, 0)
    // …but the silence is surfaced
    assert.equal(s.alerts.length, 1)
    assert.match(s.alerts[0]!, /may be down/)
    assert.match(s.alerts[0]!, /Kilo Code/)
  })

  test('failing below the streak with fresh threads alerts as unproven', async () => {
    const threads = [thread('kilo-code[bot]', fresh)]
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(2), // 2 < 3
    })
    assert.equal(s.alerts.length, 1)
    assert.match(s.alerts[0]!, /not yet proven flaky/)
  })

  test('streak + fresh thread by the check bot earns the quiet ignore', async () => {
    const threads = [thread('kilo-code[bot]', fresh)]
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(5),
    })
    assert.deepEqual(s.alerts, [])
    assert.equal(s.reviewersFailing, 0)
  })

  test('threads by another author do not certify the reviewer alive', async () => {
    const threads = [thread('human-reviewer', fresh), thread('greptile-apps[bot]', fresh)]
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    })
    assert.equal(s.alerts.length, 1)
    assert.match(s.alerts[0]!, /may be down/)
  })

  test('a matching thread outside the window is not proof of life', async () => {
    const threads = [thread('kilo-code[bot]', stale)]
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: memHistory(9),
    })
    assert.equal(s.alerts.length, 1)
    assert.match(s.alerts[0]!, /may be down/)
  })

  test('a bare string entry is a rule with default thresholds', async () => {
    const threads = [thread('kilo-code[bot]', fresh)]
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: ['kilo'],
      checkHistory: memHistory(3), // default consecutiveFailures
    })
    assert.deepEqual(s.alerts, [])
  })

  test('no history means no streak — a first-seen failure alerts', async () => {
    const threads = [thread('kilo-code[bot]', fresh)]
    const s = await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], threads), target, {
      ignoreChecks: rules,
      checkHistory: null,
    })
    assert.equal(s.alerts.length, 1)
    assert.match(s.alerts[0]!, /not yet proven flaky/)
  })

  test('the current observation is recorded before the verdict', async () => {
    const h = memHistory(0)
    await fetchPrActState(fakeRev([check('Kilo Code', 'fail')], []), target, {
      ignoreChecks: rules,
      checkHistory: h,
    })
    assert.deepEqual(h.recorded, [`Kilo Code@${SHA.slice(0, 7)}=fail`])
  })
})
