import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { DecideResult, JudgeAnswer, JudgeFacade } from '@broject/core'
import { chainedJudge } from './chain.ts'

const OPTS = { confidence: 0.6, timeoutMs: 3_000 }

// a choice answer can legitimately self-report confidence under 0.5 —
// a noul can't (its derived confidence is max(p, 1-p) ≥ 0.5), so the
// low-confidence fixtures use choice to stay self-consistent
const ans = (confidence: number, decidedBy = 'primary'): JudgeAnswer => ({
  type: 'choice',
  choice: 'a',
  probabilities: { a: confidence },
  confidence,
  decidedBy,
})

function fakeFacade(
  result: Partial<DecideResult> & { answers: Record<string, JudgeAnswer> },
  calls?: string[]
): JudgeFacade {
  return {
    decide: async (_state, questions) => {
      calls?.push(Object.keys(questions).join(','))
      return {
        model: 'fake-1',
        latencyMs: 5,
        lowConfidence: [],
        ...result,
      }
    },
  }
}

// choice questions — the ans() fixtures return choice answers, so the
// question/answer pairs stay contract-consistent
const Q = {
  q1: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } },
} as const

describe('chainedJudge', () => {
  test('all-confident answers never touch the fallback', async () => {
    const fbCalls: string[] = []
    const j = chainedJudge(
      fakeFacade({ answers: { q1: ans(0.9) } }),
      fakeFacade({ answers: {} }, fbCalls),
      OPTS
    )
    const res = await j.decide('s', { ...Q })
    assert.equal(res.answers.q1!.confidence, 0.9)
    assert.deepEqual(res.lowConfidence, [])
    assert.equal(fbCalls.length, 0)
  })

  test('low-confidence answers escalate; decidedBy stays honest', async () => {
    const fbCalls: string[] = []
    const j = chainedJudge(
      fakeFacade({
        answers: { q1: ans(0.4), q2: ans(0.95) },
        usage: { inputTokens: 10, costUsd: 0.001 },
      }),
      fakeFacade(
        {
          answers: { q1: ans(0.9, 'llm-judge') },
          model: 'fb-1',
          usage: { inputTokens: 20, costUsd: 0.002 },
        },
        fbCalls
      ),
      OPTS
    )
    const res = await j.decide('s', { q1: Q.q1, q2: Q.q1 })
    // only the low-confidence question is re-asked
    assert.deepEqual(fbCalls, ['q1'])
    assert.equal(res.answers.q1!.decidedBy, 'llm-judge')
    assert.equal(res.answers.q1!.confidence, 0.9)
    assert.equal(res.answers.q2!.decidedBy, 'primary')
    assert.deepEqual(res.lowConfidence, [])
    // usage sums across the chained calls
    assert.equal(res.usage?.inputTokens, 30)
    assert.equal(res.usage?.costUsd, 0.003)
    assert.equal(res.model, 'fake-1')
  })

  test('a fallback still unsure leaves the answer in lowConfidence', async () => {
    const j = chainedJudge(
      fakeFacade({ answers: { q1: ans(0.4) } }),
      fakeFacade({ answers: { q1: ans(0.5, 'llm-judge') }, model: 'fb' }),
      OPTS
    )
    const res = await j.decide('s', { ...Q })
    assert.equal(res.answers.q1!.decidedBy, 'llm-judge')
    assert.deepEqual(res.lowConfidence, ['q1'])
  })

  test('a dead fallback keeps the primary answers — fail-open', async () => {
    const j = chainedJudge(
      fakeFacade({ answers: { q1: ans(0.4) } }),
      {
        decide: () => Promise.reject(new JudgeUnavailable('down')),
      },
      OPTS
    )
    const res = await j.decide('s', { ...Q })
    assert.equal(res.answers.q1!.decidedBy, 'primary')
    assert.deepEqual(res.lowConfidence, ['q1'])
  })

  test('no fallback configured — low-confidence answers mark the list', async () => {
    const j = chainedJudge(fakeFacade({ answers: { q1: ans(0.4) } }), undefined, OPTS)
    const res = await j.decide('s', { ...Q })
    assert.deepEqual(res.lowConfidence, ['q1'])
  })

  test('an unanswered question stays low after escalation', async () => {
    const j = chainedJudge(
      fakeFacade({ answers: { q1: ans(0.4) } }),
      fakeFacade({ answers: {} }), // fallback answers nothing
      OPTS
    )
    const res = await j.decide('s', { ...Q })
    assert.equal(res.answers.q1!.decidedBy, 'primary')
    assert.deepEqual(res.lowConfidence, ['q1'])
  })

  test('a question the primary never answered escalates too', async () => {
    const fbCalls: string[] = []
    const j = chainedJudge(
      fakeFacade({ answers: { q1: ans(0.9) } }), // q2 absent entirely
      fakeFacade({ answers: { q2: ans(0.8, 'llm-judge') } }, fbCalls),
      OPTS
    )
    const res = await j.decide('s', { q1: Q.q1, q2: Q.q1 })
    assert.deepEqual(fbCalls, ['q2'])
    assert.equal(res.answers.q2!.decidedBy, 'llm-judge')
    assert.deepEqual(res.lowConfidence, [])
  })

  test('a prototype-named qid ("constructor") is not a phantom answer', async () => {
    const fbCalls: string[] = []
    const res = await chainedJudge(
      fakeFacade({ answers: {} }),
      fakeFacade({ answers: { constructor: ans(0.9, 'llm-judge') } }, fbCalls),
      OPTS
    ).decide('s', { constructor: Q.q1 })
    assert.deepEqual(fbCalls, ['constructor'])
    assert.equal(res.answers['constructor']!.decidedBy, 'llm-judge')
    // unanswered on both sides — no prototype member leaks into answers
    const res2 = await chainedJudge(
      fakeFacade({ answers: {} }),
      fakeFacade({ answers: {} }),
      OPTS
    ).decide('s', { constructor: Q.q1 })
    assert.equal(Object.hasOwn(res2.answers, 'constructor'), false)
    assert.deepEqual(res2.lowConfidence, ['constructor'])
  })

  test('a fallback bug (plain error) propagates — only unavailability fails open', async () => {
    const j = chainedJudge(
      fakeFacade({ answers: { q1: ans(0.4) } }),
      { decide: () => Promise.reject(new Error('422 validation — caller bug')) },
      OPTS
    )
    await assert.rejects(j.decide('s', { ...Q }), /caller bug/)
  })

  test('the deadline bounds the whole chain — a spent budget skips escalation', async () => {
    const fbCalls: string[] = []
    // a deadline-aware backend that overshoots — the chain sees no
    // budget left and never fires the escalation
    const slowPrimary = {
      decide: async () => {
        throw new Error('unreachable — decideWithin is used')
      },
      decideWithin: async () => {
        await new Promise((r) => setTimeout(r, 60))
        return {
          answers: { q1: ans(0.4) },
          model: 'slow',
          latencyMs: 60,
          lowConfidence: [],
        }
      },
    }
    const j = chainedJudge(
      slowPrimary,
      fakeFacade({ answers: { q1: ans(0.9, 'llm-judge') } }, fbCalls),
      { confidence: 0.6, timeoutMs: 30 }
    )
    const res = await j.decide('s', { ...Q })
    // primary already ate the budget — the escalation never fires
    assert.equal(fbCalls.length, 0)
    assert.deepEqual(res.lowConfidence, ['q1'])
  })
})
