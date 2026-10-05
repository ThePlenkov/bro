/**
 * Judge stats — agreement matrix, calibration buckets, latency/cost
 * over the verdict journal (spec: specs/sessions/bro-f4ot.2-judge.md
 * §success metrics, milestone bro-f4ot.2.4). Reads
 * `<git-common>/bro/judge/verdicts.jsonl`, joins `act-disposition`
 * rows onto their verdicts by (threadId, commentSha), and scores the
 * judge's `action` answer against the recorded outcome.
 *
 * Replay verdicts (`replay: true`) are training data — excluded from
 * the live report by default, scoreable via `opts.replay` for the
 * dogfood milestone. Unclassifiable subjects (no outcome) are dropped
 * from the agreement set — silent misclassification is worse than a
 * smaller sample.
 *
 * Journal fields (`outcome`, `choice`, `decidedBy`, `model`) are
 * untrusted keys: every aggregate they index is a Map internally, and
 * the public Record shapes are built via Object.fromEntries — a
 * '__proto__' outcome can't reach Object.prototype through this file.
 */
import type { Disposition, JournalRow, Verdict } from '@broject/core'

/** What an `action` choice claims will happen — the agreement test is
 *  `ACTION_FOR_OUTCOME.get(outcome) === choice`: `resolve` covers both
 *  fix-then-resolve and invalid-finding-resolve per spec, so `fixed`
 *  and `rejected` both map to it. */
const ACTION_FOR_OUTCOME = new Map<string, string>([
  ['fixed', 'resolve'],
  ['rejected', 'resolve'],
  ['replied', 'reply'],
  ['deferred', 'defer'],
])

/** The blocks_correctness proxy — an outcome says what happened, not
 *  whether the thread truly blocked correctness: `fixed` ≈ blocking,
 *  `deferred`/`rejected` ≈ not. `replied` is genuinely ambiguous
 *  (a rebuttal can be right on a blocking finding) — excluded. */
const BLOCKING_FOR_OUTCOME = new Map<string, boolean>([
  ['fixed', true],
  ['deferred', false],
  ['rejected', false],
])

export interface StatsOpts {
  /** ISO timestamp — verdicts older than this are excluded.
   *  Dispositions are NOT filtered: the outcome is a fact whenever it
   *  was observed. */
  since?: string
  /** Score replay (dogfood) verdicts instead of live ones — the two
   *  sets never mix in one report. */
  replay?: boolean
}

interface Tally {
  n: number
  agreed: number
}

export interface JudgeStats {
  /** decide() calls scored in this report (post-dedupe for subjects,
   *  every call for latency/cost). */
  verdicts: number
  /** Verdicts of the other set (live ↔ replay) kept out. */
  excluded: number
  /** Subjects collapsed by the (threadId, commentSha) dedupe. */
  deduped: number
  agreement: {
    /** Verdicts with an action answer AND a known outcome. */
    n: number
    agreed: number
    /** predicted action → outcome → count. */
    matrix: Record<string, Record<string, number>>
    byDecider: Record<string, Tally>
    /** Action-answered verdicts with no outcome — excluded, not failed. */
    unscored: number
  }
  /** Proxy-scored — reported separately, never counts toward the 85%
   *  bar (spec: the outcome can't say whether the thread truly blocked
   *  correctness). */
  blockingProxy: Tally & { unscored: number }
  /** confidence bucket → empirical agreement on scored actions. */
  calibration: Array<Tally & { bucket: string }>
  latency: { n: number; p50: number; p95: number; mean: number }
  cost: {
    /** Calls carrying costUsd. */
    n: number
    /** Calls without cost data — the true spend is higher than shown. */
    noCost: number
    total: number
    mean: number
    /** "<provider(s)>/<model>" → spend — escalation verdicts key as
     *  'llm-judge+systemone/<model>' so fallback cost is attributable. */
    byProviderModel: Record<string, { n: number; total: number; mean: number }>
  }
}

const isVerdict = (r: JournalRow): r is Verdict => r.kind !== 'act-disposition'

/** Latest disposition for a subject — threadId must match; a commentSha
 *  present on both sides must equal (a moved comment is a different
 *  subject). Later journal rows win: the most recent observation is
 *  the outcome. A verdict carrying its own `outcome` (replay,
 *  dogfood) is the first hit and wins over any disposition. */
function findOutcome(verdict: Verdict, dispositions: Disposition[]): string | undefined {
  if (verdict.outcome !== undefined) {
    return verdict.outcome
  }
  const tid = verdict.subject.threadId
  if (tid === undefined) {
    return undefined
  }
  const vc = verdict.subject.commentSha
  for (let i = dispositions.length - 1; i >= 0; i -= 1) {
    const d = dispositions[i]!
    if (d.subject.threadId !== tid) {
      continue
    }
    // a verdict that knows its commentSha only joins a disposition
    // carrying the same one — a SHA-less disposition may predate the
    // comment's last edit, and scoring it here would grade the new
    // comment by the old finding's outcome
    if (vc !== undefined && d.subject.commentSha !== vc) {
      continue
    }
    return d.outcome
  }
  return undefined
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!

/** The cost attribution key — a verdict's answers usually share one
 *  decider; an escalated set keys as 'llm-judge+systemone/<model>' so the
 *  report shows what escalation spends, not just the primary. */
const providerModel = (v: Verdict): string => {
  const providers = [...new Set(Object.values(v.answers).map((a) => a.decidedBy))].sort(
    (a, b) => a.localeCompare(b)
  )
  return `${providers.length > 0 ? providers.join('+') : 'unknown'}/${v.model}`
}

const CALIBRATION_BUCKETS: Array<[number, number, string]> = [
  [0, 0.5, '0.00–0.50'],
  [0.5, 0.6, '0.50–0.60'],
  [0.6, 0.7, '0.60–0.70'],
  [0.7, 0.8, '0.70–0.80'],
  [0.8, 0.9, '0.80–0.90'],
  [0.9, 1.01, '0.90–1.00'],
]

const bucketFor = (confidence: number): string => {
  for (const [lo, hi, label] of CALIBRATION_BUCKETS) {
    if (confidence >= lo && confidence < hi) {
      return label
    }
  }
  return '0.90–1.00'
}

const bump = (t: Tally, agreed: boolean): void => {
  t.n += 1
  if (agreed) {
    t.agreed += 1
  }
}

/** get-or-create for Map<string, T> — the S1121-clean form of
 *  `(m[k] ??= init())`. */
function mapGet<K, V>(m: Map<K, V>, k: K, init: () => V): V {
  const cur = m.get(k)
  if (cur !== undefined) {
    return cur
  }
  const v = init()
  m.set(k, v)
  return v
}

/** `action` answer vs outcome — agreement matrix, per-decider tallies,
 *  and the confidence bucket this prediction lands in. */
function scoreAction(
  v: Verdict,
  outcome: string | undefined,
  agreement: { n: number; agreed: number; unscored: number },
  matrix: Map<string, Map<string, number>>,
  byDecider: Map<string, Tally>,
  calibration: Map<string, Tally>
): void {
  const action = v.answers.action
  if (action?.type !== 'choice') {
    return
  }
  const expected = outcome === undefined ? undefined : ACTION_FOR_OUTCOME.get(outcome)
  if (expected === undefined) {
    agreement.unscored += 1
    return
  }
  const agreed = expected === action.choice
  bump(agreement, agreed)
  const row = mapGet(matrix, action.choice, () => new Map<string, number>())
  row.set(outcome!, (row.get(outcome!) ?? 0) + 1)
  bump(mapGet(byDecider, action.decidedBy, () => ({ n: 0, agreed: 0 })), agreed)
  bump(mapGet(calibration, bucketFor(action.confidence), () => ({ n: 0, agreed: 0 })), agreed)
}

/** `blocks_correctness` noul vs the outcome proxy — fixed ≈ blocking,
 *  deferred/rejected ≈ not; anything else is unscored. */
function scoreBlocking(
  v: Verdict,
  outcome: string | undefined,
  proxy: Tally & { unscored: number }
): void {
  const bc = v.answers.blocks_correctness
  if (bc?.type !== 'noul') {
    return
  }
  const truth = outcome === undefined ? undefined : BLOCKING_FOR_OUTCOME.get(outcome)
  if (truth === undefined) {
    proxy.unscored += 1
    return
  }
  bump(proxy, bc.noul >= 0.5 === truth)
}

interface SubjectScoring {
  agreement: JudgeStats['agreement']
  blockingProxy: JudgeStats['blockingProxy']
  calibration: JudgeStats['calibration']
}

/** Agreement over the deduped subject set — one verdict per
 *  (threadId, commentSha) pair stands, per spec. */
function scoreSubjects(subjects: Verdict[], dispositions: Disposition[]): SubjectScoring {
  const agreement = { n: 0, agreed: 0, unscored: 0 }
  const matrix = new Map<string, Map<string, number>>()
  const byDecider = new Map<string, Tally>()
  const calibration = new Map<string, Tally>()
  const proxy: Tally & { unscored: number } = { n: 0, agreed: 0, unscored: 0 }
  for (const v of subjects) {
    const outcome = findOutcome(v, dispositions)
    scoreAction(v, outcome, agreement, matrix, byDecider, calibration)
    scoreBlocking(v, outcome, proxy)
  }
  return {
    agreement: {
      ...agreement,
      matrix: Object.fromEntries(
        [...matrix.entries()].map(([k, row]) => [k, Object.fromEntries(row)])
      ),
      byDecider: Object.fromEntries(byDecider),
    },
    blockingProxy: proxy,
    calibration: CALIBRATION_BUCKETS.map(([, , bucket]) => ({
      bucket,
      ...(calibration.get(bucket) ?? { n: 0, agreed: 0 }),
    })),
  }
}

interface CallStats {
  latency: JudgeStats['latency']
  cost: JudgeStats['cost']
}

/** Latency and spend over EVERY recorded decide() — a deduped re-judge
 *  still paid for its call, so per-call metrics never run on the
 *  subject set (agreement does — one verdict per pair stands). */
function tallyCalls(scoped: Verdict[]): CallStats {
  const latencies = scoped.map((v) => v.latencyMs).sort((a, b) => a - b)
  const byPM = new Map<string, { n: number; total: number; mean: number }>()
  const cost = { n: 0, noCost: 0, total: 0, mean: 0 }
  for (const v of scoped) {
    if (v.costUsd === undefined) {
      cost.noCost += 1
      continue
    }
    cost.n += 1
    cost.total += v.costUsd
    const pm = mapGet(byPM, providerModel(v), () => ({ n: 0, total: 0, mean: 0 }))
    pm.n += 1
    pm.total += v.costUsd
  }
  for (const pm of byPM.values()) {
    pm.mean = pm.total / pm.n
  }
  cost.mean = cost.n > 0 ? cost.total / cost.n : 0
  return {
    latency: {
      n: latencies.length,
      p50: latencies.length > 0 ? percentile(latencies, 0.5) : 0,
      p95: latencies.length > 0 ? percentile(latencies, 0.95) : 0,
      mean:
        latencies.length > 0
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : 0,
    },
    cost: { ...cost, byProviderModel: Object.fromEntries(byPM) },
  }
}

/** The subject set for agreement — at most one verdict per
 *  (threadId, commentSha) pair; journal order is append order, so the
 *  last write stands. Verdicts with no subject identity (smoke calls)
 *  are each their own. */
function dedupeSubjects(scoped: Verdict[]): Verdict[] {
  const bySubject = new Map<string, Verdict>()
  const subjectless: Verdict[] = []
  for (const v of scoped) {
    const tid = v.subject.threadId
    if (tid === undefined) {
      subjectless.push(v)
      continue
    }
    bySubject.set(`${tid} ${v.subject.commentSha ?? ''}`, v)
  }
  return [...subjectless, ...bySubject.values()]
}

/** Score the journal — pure over rows, so tests and `bro judge stats`
 *  share the exact computation. */
export function computeStats(rows: JournalRow[], opts: StatsOpts = {}): JudgeStats {
  const wantReplay = opts.replay === true
  const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : undefined
  const dispositions = rows.filter((r): r is Disposition => r.kind === 'act-disposition')
  const all = rows.filter(isVerdict)
  const inSet = all.filter((v) => (v.replay === true) === wantReplay)
  const scoped =
    sinceMs !== undefined && Number.isFinite(sinceMs)
      ? inSet.filter((v) => Date.parse(v.ts) >= sinceMs)
      : inSet
  const subjects = dedupeSubjects(scoped)
  const { latency, cost } = tallyCalls(scoped)
  const scored = scoreSubjects(subjects, dispositions)
  return {
    verdicts: scoped.length,
    excluded: all.length - inSet.length,
    deduped: scoped.length - subjects.length,
    ...scored,
    latency,
    cost,
  }
}

const pct = (t: Tally): string => (t.n > 0 ? `${((100 * t.agreed) / t.n).toFixed(1)}%` : '—')
const usd = (v: number): string => `$${v.toFixed(4)}`

/** The success-metric verdict line — agreement ≥85% (action vs
 *  outcome), p50 latency <1s, mean cost <$0.01 (spec §success
 *  metrics). Insufficient sample reports 'no data', not a pass. */
function thresholdLine(s: JudgeStats): string {
  const agreement =
    s.agreement.n === 0
      ? 'agreement no-data'
      : `agreement ${pct(s.agreement)} ${s.agreement.agreed / s.agreement.n >= 0.85 ? '≥' : '<'} 85%`
  const latency =
    s.latency.n === 0
      ? 'latency no-data'
      : `p50 ${Math.round(s.latency.p50)}ms ${s.latency.p50 < 1000 ? '<' : '≥'} 1s`
  const cost =
    s.cost.n === 0
      ? 'cost no-data'
      : `mean ${usd(s.cost.mean)} ${s.cost.mean < 0.01 ? '<' : '≥'} $0.01` +
        (s.cost.noCost > 0 ? ` (${s.cost.noCost} unmeasured)` : '')
  return `thresholds: ${[agreement, latency, cost].join(' · ')}`
}

function agreementLines(s: JudgeStats): string[] {
  const head =
    `agreement (action vs outcome): ${pct(s.agreement)} — ${s.agreement.agreed}/${s.agreement.n}` +
    (s.agreement.unscored > 0 ? ` · ${s.agreement.unscored} unscored (no outcome)` : '')
  const outcomes = [
    ...new Set(Object.values(s.agreement.matrix).flatMap((r) => Object.keys(r))),
  ].sort((a, b) => a.localeCompare(b))
  const actions = Object.keys(s.agreement.matrix).sort((a, b) => a.localeCompare(b))
  const lines = [head]
  if (actions.length > 0) {
    const w = Math.max(7, ...actions.map((a) => a.length))
    const header = `  ${'predicted'.padEnd(w)}  ${outcomes.map((o) => o.padStart(8)).join('')}`
    const rows = actions.map(
      (a) =>
        `  ${a.padEnd(w)}  ${outcomes
          .map((o) => String(s.agreement.matrix[a]![o] ?? 0).padStart(8))
          .join('')}`
    )
    lines.push(header, ...rows)
  }
  const deciders = Object.entries(s.agreement.byDecider)
  if (deciders.length > 0) {
    lines.push(
      `  by decider: ${deciders
        .map(([d, t]) => `${d} ${t.agreed}/${t.n} (${pct(t)})`)
        .join(' · ')}`
    )
  }
  return lines
}

function costLines(s: JudgeStats): string[] {
  const costTail = s.cost.noCost > 0 ? ` · ${s.cost.noCost} calls without cost data` : ''
  const lines = [
    `latency: n=${s.latency.n} p50=${Math.round(s.latency.p50)}ms p95=${Math.round(s.latency.p95)}ms mean=${Math.round(s.latency.mean)}ms`,
    `cost: n=${s.cost.n} total=${usd(s.cost.total)} mean=${usd(s.cost.mean)}${costTail}`,
  ]
  const pm = Object.entries(s.cost.byProviderModel).sort((a, b) => b[1].total - a[1].total)
  if (pm.length === 0) {
    return lines
  }
  return [
    ...lines,
    '  per provider/model:',
    ...pm.map(([k, t]) => `    ${k}  n=${t.n} total=${usd(t.total)} mean=${usd(t.mean)}`),
  ]
}

/** Text report — compact, monospace-safe; --json carries the same
 *  JudgeStats structure for scripting. */
export function formatStats(s: JudgeStats, opts: StatsOpts = {}): string {
  const scope = [
    `${s.verdicts} verdicts${opts.replay === true ? ' (replay)' : ''}`,
    opts.since !== undefined ? `since ${opts.since}` : undefined,
    s.excluded > 0
      ? `${s.excluded} ${opts.replay === true ? 'live' : 'replay'} excluded`
      : undefined,
    s.deduped > 0 ? `${s.deduped} deduped` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const proxyTail =
    s.blockingProxy.unscored > 0 ? ` · ${s.blockingProxy.unscored} unscored` : ''
  const sections = [
    [`judge stats — ${scope}`],
    agreementLines(s),
    [
      `blocks_correctness (proxy-scored — does not count toward the bar): ${pct(s.blockingProxy)} — ${s.blockingProxy.agreed}/${s.blockingProxy.n}${proxyTail}`,
    ],
    [
      'calibration (confidence × agreement):',
      ...s.calibration.map((b) => `  ${b.bucket}  n=${b.n}  ${pct(b)}`),
    ],
    costLines(s),
    [thresholdLine(s)],
  ]
  return sections.map((sec) => sec.join('\n')).join('\n\n') + '\n'
}
