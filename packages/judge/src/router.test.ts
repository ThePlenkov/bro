import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JudgeUnavailable } from '@broject/core'
import type {
  DecideResult,
  JudgeFacade,
  JudgeQuestion,
  RoutingTable,
  Verdict,
} from '@broject/core'
import { readJournal } from './journal.ts'
import { ROUTE_CLASS_KIND, routeClass, routeClassQuestions } from './router.ts'

const withRepo = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-judge-router-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ROUTING: RoutingTable = {
  default: { chain: [{ provider: 'devin' }, { provider: 'kilo-free' }] },
  sweep: { chain: [{ provider: 'kilo-free', model: 'auto/free' }] },
}

/** A JudgeFacade returning a scripted DecideResult. */
const judgeReturning = (res: Partial<DecideResult>): JudgeFacade => ({
  decide: async () => ({
    answers: {},
    model: 'jev-test',
    latencyMs: 1,
    lowConfidence: [],
    ...res,
  }),
})

const judgeFailing = (err: Error): JudgeFacade => ({
  decide: async () => {
    throw err
  },
})

const pick = (choice: string, confidence = 0.9): Partial<DecideResult> => ({
  answers: {
    class: {
      type: 'choice',
      choice,
      probabilities: {},
      confidence,
      decidedBy: 'provider:orca',
    },
  },
})

const lastVerdict = (dir: string): Verdict => {
  const rows = readJournal(dir).filter((r): r is Verdict => 'questions' in r)
  assert.ok(rows.length > 0, 'expected a journaled verdict')
  return rows.at(-1)!
}

describe('routeClassQuestions', () => {
  test('one choice question keyed class; criteria ARE the routing table keys', () => {
    const qs = routeClassQuestions(ROUTING)
    assert.deepEqual(Object.keys(qs), ['class'])
    const q = qs['class']!
    assert.equal(q.type, 'choice')
    assert.deepEqual(Object.keys(q.criteria).sort(), ['default', 'sweep'])
    // the criterion describes the chain the lane lands on
    assert.match(q.criteria['sweep']!, /kilo-free\(auto\/free\)/)
    assert.match(q.criteria['default']!, /devin → kilo-free/)
  })

  test('a "__proto__" class lands as an own key, never a prototype write', () => {
    const t: RoutingTable = JSON.parse('{"__proto__":{"chain":[{"provider":"devin"}]}}')
    const qs = routeClassQuestions(t)
    const criteria = (qs['class'] as JudgeQuestion & { type: 'choice' }).criteria
    assert.ok(Object.hasOwn(criteria, '__proto__'))
    assert.match(criteria['__proto__']!, /devin/)
  })
})

describe('routeClass', () => {
  const state = { molStep: 'fx-1', title: 'sweep the ledger', description: '' }

  test('shadow journals the verdict beside the resolved class and picks nothing', () =>
    withRepo(async (dir) => {
      const got = await routeClass({
        dir,
        judge: judgeReturning(pick('sweep')),
        molStep: 'fx-1',
        state,
        routing: ROUTING,
        resolved: 'default',
        mode: 'shadow',
      })
      assert.equal(got, undefined)
      const v = lastVerdict(dir)
      assert.equal(v.kind, ROUTE_CLASS_KIND)
      assert.equal(v.subject.threadId, 'fx-1')
      // the pick is journaled, the OUTCOME is the resolved class
      assert.equal(v.outcome, 'default')
      const a = v.answers['class']!
      assert.equal(a.type, 'choice')
      if (a.type === 'choice') {
        assert.equal(a.choice, 'sweep')
      }
    }))

  test('enforce returns a confident declared pick and journals it as the outcome', () =>
    withRepo(async (dir) => {
      const got = await routeClass({
        dir,
        judge: judgeReturning(pick('sweep', 0.95)),
        molStep: 'fx-1',
        state,
        routing: ROUTING,
        resolved: 'default',
        mode: 'enforce',
      })
      assert.equal(got, 'sweep')
      assert.equal(lastVerdict(dir).outcome, 'sweep')
    }))

  test('enforce with a low-confidence answer stands — resolved is the outcome', () =>
    withRepo(async (dir) => {
      const got = await routeClass({
        dir,
        judge: judgeReturning({ ...pick('sweep', 0.2), lowConfidence: ['class'] }),
        molStep: 'fx-1',
        state,
        routing: ROUTING,
        resolved: 'default',
        mode: 'enforce',
      })
      assert.equal(got, undefined)
      const v = lastVerdict(dir)
      assert.equal(v.outcome, 'default')
      assert.deepEqual(v.lowConfidence, ['class'])
    }))

  test('enforce never invents a class — an off-table pick is no verdict', () =>
    withRepo(async (dir) => {
      const got = await routeClass({
        dir,
        judge: judgeReturning(pick('ghost', 0.99)),
        molStep: 'fx-1',
        state,
        routing: ROUTING,
        resolved: 'default',
        mode: 'enforce',
      })
      assert.equal(got, undefined)
      assert.equal(lastVerdict(dir).outcome, 'default')
    }))

  test('an unanswered question is no verdict under either mode', () =>
    withRepo(async (dir) => {
      for (const mode of ['shadow', 'enforce'] as const) {
        const got = await routeClass({
          dir,
          judge: judgeReturning({ lowConfidence: ['class'] }),
          molStep: 'fx-1',
          state,
          routing: ROUTING,
          resolved: 'default',
          mode,
        })
        assert.equal(got, undefined, mode)
      }
    }))

  test('JudgeUnavailable propagates — the caller owns the warn-and-stand', () =>
    withRepo(async (dir) => {
      await assert.rejects(
        () =>
          routeClass({
            dir,
            judge: judgeFailing(new JudgeUnavailable('quota exhausted')),
            molStep: 'fx-1',
            state,
            routing: ROUTING,
            resolved: 'default',
            mode: 'enforce',
          }),
        JudgeUnavailable
      )
      assert.equal(readJournal(dir).length, 0)
    }))
})
