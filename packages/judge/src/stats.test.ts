import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Disposition, JudgeAnswer, JournalRow, Verdict } from '@broject/core'
import { computeStats, formatStats } from './stats.ts'

const answers = (over: {
  action?: [string, number, string]
  noul?: [number, string]
}): Record<string, JudgeAnswer> => {
  const out: Record<string, JudgeAnswer> = {}
  if (over.action !== undefined) {
    const [choice, confidence, decidedBy] = over.action
    out.action = { type: 'choice', choice, probabilities: {}, confidence, decidedBy }
  }
  if (over.noul !== undefined) {
    const [noul, decidedBy] = over.noul
    out.blocks_correctness = { type: 'noul', noul, confidence: Math.max(noul, 1 - noul), decidedBy }
  }
  return out
}

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  ts: '2026-01-01T00:00:00Z',
  kind: 'act-thread',
  subject: { pr: 7, threadId: 'T1', commentSha: 'abc' },
  questions: {},
  answers: answers({ action: ['resolve', 0.9, 'jev'] }),
  model: 'jev-1.13.0',
  latencyMs: 100,
  costUsd: 0.001,
  ...over,
})

const disp = (threadId: string, outcome: string, commentSha?: string): Disposition => ({
  ts: '2026-01-02T00:00:00Z',
  kind: 'act-disposition',
  subject: { pr: 7, threadId, ...(commentSha !== undefined ? { commentSha } : {}) },
  outcome,
})

describe('computeStats', () => {
  test('agreement: resolve covers fixed + rejected; reply/defer map 1:1', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' }, answers: answers({ action: ['resolve', 0.9, 'jev'] }) }),
      verdict({ subject: { threadId: 'T2' }, answers: answers({ action: ['resolve', 0.9, 'jev'] }) }),
      verdict({ subject: { threadId: 'T3' }, answers: answers({ action: ['reply', 0.8, 'jev'] }) }),
      verdict({ subject: { threadId: 'T4' }, answers: answers({ action: ['defer', 0.7, 'jev'] }) }),
      verdict({ subject: { threadId: 'T5' }, answers: answers({ action: ['resolve', 0.9, 'jev'] }) }),
      disp('T1', 'fixed'),
      disp('T2', 'rejected'), // resolve-as-invalid still agrees
      disp('T3', 'replied'),
      disp('T4', 'fixed'), // judge said defer, reality fixed → disagree
      disp('T5', 'deferred'),
    ]
    const s = computeStats(rows)
    assert.equal(s.agreement.n, 5)
    assert.equal(s.agreement.agreed, 3)
    assert.equal(s.agreement.matrix.resolve?.fixed, 1)
    assert.equal(s.agreement.matrix.resolve?.rejected, 1)
    assert.equal(s.agreement.matrix.resolve?.deferred, 1)
    assert.equal(s.agreement.matrix.defer?.fixed, 1)
    assert.equal(s.agreement.byDecider.jev?.agreed, 3)
  })

  test('unscored: no outcome, unknown outcome kind, or no action answer', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' } }), // no outcome
      verdict({ subject: { threadId: 'T2' }, answers: {} }), // no action answer
      verdict({ subject: { threadId: 'T3' } }),
      disp('T3', 'mysterious'), // outcome outside the known set
    ]
    const s = computeStats(rows)
    assert.equal(s.agreement.n, 0)
    assert.equal(s.agreement.unscored, 2) // T1 + T3
    assert.equal(s.verdicts, 3)
  })

  test('verdict.outcome wins over a conflicting disposition; dispositions join by threadId + commentSha', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1', commentSha: 'a' }, outcome: 'fixed' }),
      verdict({ subject: { threadId: 'T2', commentSha: 'b' } }),
      verdict({ subject: { threadId: 'T2', commentSha: 'c' } }),
      disp('T1', 'deferred', 'a'), // contradicts the verdict's own outcome — loses
      disp('T2', 'deferred', 'b'), // joins only the matching commentSha
    ]
    const s = computeStats(rows)
    assert.equal(s.agreement.n, 2) // T1 (own outcome) + T2/b
    assert.equal(s.agreement.matrix.resolve?.fixed, 1) // T1 scored as fixed, not deferred
    assert.equal(s.agreement.matrix.resolve?.deferred, 1) // T2/b
  })

  test('journal-controlled keys cannot reach Object.prototype', () => {
    const rows: JournalRow[] = [
      verdict({
        subject: { threadId: 'T1' },
        answers: answers({ action: ['__proto__', 0.9, '__proto__'] }),
      }),
      disp('T1', '__proto__'), // unknown outcome → unscored, no pollution
      verdict({ subject: { threadId: 'T2' } }),
      disp('T2', 'fixed'),
    ]
    const s = computeStats(rows)
    assert.equal(s.agreement.unscored, 1)
    assert.equal(s.agreement.n, 1)
    const protoKey = '__proto__'
    assert.equal(Object.keys(s.agreement.matrix).includes(protoKey), false)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  test('a moved commentSha does not join the old disposition', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1', commentSha: 'new' } }),
      disp('T1', 'fixed', 'old'),
    ]
    const s = computeStats(rows)
    assert.equal(s.agreement.n, 0)
    assert.equal(s.agreement.unscored, 1)
  })

  test('dedupe: one verdict per (threadId, commentSha), latest stands', () => {
    const rows: JournalRow[] = [
      verdict({
        subject: { threadId: 'T1', commentSha: 'a' },
        answers: answers({ action: ['defer', 0.7, 'jev'] }),
      }),
      verdict({
        ts: '2026-01-01T01:00:00Z',
        subject: { threadId: 'T1', commentSha: 'a' },
        answers: answers({ action: ['resolve', 0.9, 'jev'] }),
      }),
      disp('T1', 'fixed', 'a'),
    ]
    const s = computeStats(rows)
    assert.equal(s.verdicts, 2)
    assert.equal(s.deduped, 1)
    assert.equal(s.agreement.n, 1)
    assert.equal(s.agreement.agreed, 1) // latest said resolve, outcome fixed
    assert.equal(s.latency.n, 2) // per-call metrics count every decide()
  })

  test('replay rows stay out of live stats; --replay scores them', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' } }),
      verdict({ subject: { threadId: 'T2' }, replay: true }),
      disp('T1', 'fixed'),
      disp('T2', 'fixed'),
    ]
    const live = computeStats(rows)
    assert.equal(live.verdicts, 1)
    assert.equal(live.excluded, 1)
    const replayed = computeStats(rows, { replay: true })
    assert.equal(replayed.verdicts, 1)
    assert.equal(replayed.agreement.n, 1)
  })

  test('--since filters verdicts, dispositions still join', () => {
    const rows: JournalRow[] = [
      verdict({ ts: '2026-01-01T00:00:00Z', subject: { threadId: 'T1' } }),
      verdict({ ts: '2026-02-01T00:00:00Z', subject: { threadId: 'T2' } }),
      disp('T1', 'fixed'),
      disp('T2', 'deferred'),
    ]
    const s = computeStats(rows, { since: '2026-01-15' })
    assert.equal(s.verdicts, 1)
    assert.equal(s.agreement.n, 1)
    assert.equal(s.agreement.matrix.resolve?.deferred, 1)
  })

  test('blockingProxy: fixed≈blocking, deferred/rejected≈not, replied excluded', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' }, answers: answers({ noul: [0.9, 'jev'] }) }),
      verdict({ subject: { threadId: 'T2' }, answers: answers({ noul: [0.2, 'jev'] }) }),
      verdict({ subject: { threadId: 'T3' }, answers: answers({ noul: [0.9, 'jev'] }) }),
      verdict({ subject: { threadId: 'T4' }, answers: answers({ noul: [0.8, 'jev'] }) }),
      disp('T1', 'fixed'),
      disp('T2', 'deferred'),
      disp('T3', 'replied'), // ambiguous → excluded
      disp('T4', 'rejected'),
    ]
    const s = computeStats(rows)
    assert.equal(s.blockingProxy.n, 3)
    assert.equal(s.blockingProxy.agreed, 2) // T1 yes, T2 yes, T4 said blocking but wasn't
    assert.equal(s.blockingProxy.unscored, 1)
  })

  test('calibration buckets count scored action answers', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' }, answers: answers({ action: ['resolve', 0.95, 'jev'] }) }),
      verdict({ subject: { threadId: 'T2' }, answers: answers({ action: ['resolve', 0.55, 'jev'] }) }),
      verdict({ subject: { threadId: 'T3' }, answers: answers({ action: ['defer', 0.55, 'jev'] }) }),
      disp('T1', 'fixed'),
      disp('T2', 'fixed'),
      disp('T3', 'fixed'),
    ]
    const s = computeStats(rows)
    const b = (label: string) => s.calibration.find((c) => c.bucket === label)!
    assert.equal(b('0.90–1.00').n, 1)
    assert.equal(b('0.90–1.00').agreed, 1)
    assert.equal(b('0.50–0.60').n, 2)
    assert.equal(b('0.50–0.60').agreed, 1)
  })

  test('latency percentiles + cost per provider/model', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' }, latencyMs: 100, costUsd: 0.001 }),
      verdict({ subject: { threadId: 'T2' }, latencyMs: 200, costUsd: 0.003 }),
      verdict({
        subject: { threadId: 'T3' },
        latencyMs: 300,
        costUsd: 0.002,
        model: 'gpt-x',
        answers: answers({ action: ['reply', 0.9, 'llm-judge'] }),
      }),
      verdict({ subject: {}, latencyMs: 50, costUsd: undefined }), // smoke call, no cost data
    ]
    const s = computeStats(rows)
    assert.equal(s.latency.n, 4)
    assert.equal(s.latency.p50, 100)
    assert.equal(s.latency.p95, 300)
    assert.equal(s.cost.n, 3)
    assert.equal(s.cost.noCost, 1)
    assert.ok(Math.abs(s.cost.total - 0.006) < 1e-9)
    assert.ok(s.cost.byProviderModel['jev/jev-1.13.0']!.n === 2)
    assert.ok(s.cost.byProviderModel['llm-judge/gpt-x']!.n === 1)
  })

  test('escalated verdicts key cost as jev+llm-judge/<model>', () => {
    const rows: JournalRow[] = [
      verdict({
        subject: { threadId: 'T1' },
        costUsd: 0.004,
        answers: {
          action: { type: 'choice', choice: 'resolve', probabilities: {}, confidence: 0.9, decidedBy: 'llm-judge' },
          severity: { type: 'score', score: 3, probabilities: {}, confidence: 0.9, decidedBy: 'jev' },
        },
      }),
    ]
    const s = computeStats(rows)
    assert.ok(s.cost.byProviderModel['jev+llm-judge/jev-1.13.0']!.total === 0.004)
  })

  test('empty journal yields zeros, not NaN', () => {
    const s = computeStats([])
    assert.equal(s.verdicts, 0)
    assert.equal(s.agreement.n, 0)
    assert.equal(s.latency.p50, 0)
    assert.equal(s.cost.mean, 0)
    const text = formatStats(s)
    assert.match(text, /judge stats — 0 verdicts/)
    assert.match(text, /agreement no-data/)
  })
})

describe('formatStats', () => {
  test('renders matrix, deciders, buckets, latency/cost, thresholds', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' } }),
      verdict({ subject: { threadId: 'T2' }, answers: answers({ action: ['reply', 0.8, 'llm-judge'] }) }),
      disp('T1', 'fixed'),
      disp('T2', 'replied'),
    ]
    const text = formatStats(computeStats(rows))
    assert.match(text, /agreement \(action vs outcome\): 100\.0% — 2\/2/)
    assert.match(text, /by decider: .*jev 1\/1.*llm-judge 1\/1/)
    assert.match(text, /blocks_correctness \(proxy-scored/)
    assert.match(text, /calibration \(confidence × agreement\)/)
    assert.match(text, /latency: n=2 p50=100ms/)
    assert.match(text, /per provider\/model:/)
    assert.match(text, /thresholds: agreement 100\.0% ≥ 85%/)
  })

  test('cost threshold flags unmeasured calls — the mean is a floor', () => {
    const rows: JournalRow[] = [
      verdict({ subject: { threadId: 'T1' }, costUsd: 0.001 }),
      verdict({ subject: {}, costUsd: undefined }),
    ]
    const text = formatStats(computeStats(rows))
    assert.match(text, /mean \$0\.0010 < \$0\.01 \(1 unmeasured\)/)
  })
})
