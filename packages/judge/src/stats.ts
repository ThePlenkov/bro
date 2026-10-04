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
 */
import type { Disposition, JournalRow, Verdict } from '@broject/core'

/** What an `action` choice claims will happen — the agreement test is
 *  `ACTION_FOR_OUTCOME[outcome] === choice`: `resolve` covers both
 *  fix-then-resolve and invalid-finding-resolve per spec, so `fixed`
 *  and `rejected` both map to it. */
const ACTION_FOR_OUTCOME: Record<string, string> = {
  fixed: 'resolve',
  rejected: 'resolve',
  replied: 'reply',
  deferred: 'defer',
}

/** The blocks_correctness proxy — an outcome says what happened, not
 *  whether the thread truly blocked correctness: `fixed` ≈ blocking,
 *  `deferred`/`rejected` ≈ not. `replied` is genuinely ambiguous
 *  (a rebuttal can be right on a blocking finding) — excluded. */
const BLOCKING_FOR_OUTCOME: Record<string, boolean> = {
  fixed: true,
  deferred: false,
  rejected: false,
}

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
     *  'jev+llm-judge/<model>' so fallback cost is attributable. */
    byProviderModel: Record<string, { n: number; total: number; mean: number }>
  }
}

const isVerdict = (r: JournalRow): r is Verdict => r.kind !== 'act-disposition'

/** Latest disposition for a subject — threadId must match; a commentSha
 *  present on both sides must equal (a moved comment is a different
 *  subject). Later journal rows win: the most recent observation is
 *  the outcome. */
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
    const dc = d.subject.commentSha
    if (dc !== undefined && vc !== undefined && dc !== vc) {
      continue
    }
    return d.outcome
  }
  return undefined
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!

/** The cost attribution key — a verdict's answers usually share one
 *  decider; an escalated set keys as 'jev+llm-judge/<model>' so the
 *  report shows what escalation spends, not just the primary. */
const providerModel = (v: Verdict): string => {
  const providers = [...new Set(Object.values(v.answers).map((a) => a.decidedBy))].sort()
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

  // at most one verdict per (threadId, commentSha) pair — journal order
  // is append order, so the last write is the verdict that stood
  const bySubject = new Map<string, Verdict>()
  const subjects: Verdict[] = []
  for (const v of scoped) {
    const tid = v.subject.threadId
    if (tid === undefined) {
      subjects.push(v) // no subject identity — every call counts
      continue
    }
    const key = `${tid}${v.subject.commentSha ?? ''}`
    const prev = bySubject.get(key)
    if (prev === undefined) {
      bySubject.set(key, v)
      subjects.push(v)
    } else {
      bySubject.set(key, v)
      subjects[subjects.indexOf(prev)] = v
    }
  }

  const stats: JudgeStats = {
    verdicts: scoped.length,
    excluded: all.length - inSet.length,
    deduped: scoped.length - subjects.length,
    agreement: { n: 0, agreed: 0, matrix: {}, byDecider: {}, unscored: 0 },
    blockingProxy: { n: 0, agreed: 0, unscored: 0 },
    calibration: CALIBRATION_BUCKETS.map(([, , bucket]) => ({ bucket, n: 0, agreed: 0 })),
    latency: { n: 0, p50: 0, p95: 0, mean: 0 },
    cost: { n: 0, noCost: 0, total: 0, mean: 0, byProviderModel: {} },
  }

  const latencies: number[] = []
  for (const v of subjects) {
    latencies.push(v.latencyMs)
    if (v.costUsd !== undefined) {
      stats.cost.n += 1
      stats.cost.total += v.costUsd
      const key = providerModel(v)
      const pm = (stats.cost.byProviderModel[key] ??= { n: 0, total: 0, mean: 0 })
      pm.n += 1
      pm.total += v.costUsd
    } else {
      stats.cost.noCost += 1
    }

    const outcome = findOutcome(v, dispositions)
    const action = v.answers.action
    if (action?.type === 'choice') {
      if (outcome === undefined || ACTION_FOR_OUTCOME[outcome] === undefined) {
        stats.agreement.unscored += 1
      } else {
        const agreed = ACTION_FOR_OUTCOME[outcome] === action.choice
        bump(stats.agreement, agreed)
        const row = (stats.agreement.matrix[action.choice] ??= {})
        row[outcome] = (row[outcome] ?? 0) + 1
        bump((stats.agreement.byDecider[action.decidedBy] ??= { n: 0, agreed: 0 }), agreed)
        bump(
          stats.calibration.find((b) => b.bucket === bucketFor(action.confidence))!,
          agreed
        )
      }
    }

    const bc = v.answers.blocks_correctness
    if (bc?.type === 'noul') {
      const truth = outcome !== undefined ? BLOCKING_FOR_OUTCOME[outcome] : undefined
      if (truth === undefined) {
        stats.blockingProxy.unscored += 1
      } else {
        bump(stats.blockingProxy, bc.noul >= 0.5 === truth)
      }
    }
  }

  latencies.sort((a, b) => a - b)
  stats.latency = {
    n: latencies.length,
    p50: latencies.length > 0 ? percentile(latencies, 0.5) : 0,
    p95: latencies.length > 0 ? percentile(latencies, 0.95) : 0,
    mean:
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
  }
  stats.cost.mean = stats.cost.n > 0 ? stats.cost.total / stats.cost.n : 0
  for (const pm of Object.values(stats.cost.byProviderModel)) {
    pm.mean = pm.n > 0 ? pm.total / pm.n : 0
  }
  return stats
}

const pct = (t: Tally): string => (t.n > 0 ? `${((100 * t.agreed) / t.n).toFixed(1)}%` : '—')
const usd = (v: number): string => `$${v.toFixed(4)}`

/** The success-metric verdict line — agreement ≥85% (action vs
 *  outcome), p50 latency <1s, mean cost <$0.01 (spec §success
 *  metrics). Insufficient sample reports 'no data', not a pass. */
function thresholdLine(s: JudgeStats): string {
  const parts: string[] = []
  parts.push(
    s.agreement.n === 0
      ? 'agreement no-data'
      : `agreement ${pct(s.agreement)} ${s.agreement.agreed / s.agreement.n >= 0.85 ? '≥' : '<'} 85%`
  )
  parts.push(
    s.latency.n === 0
      ? 'latency no-data'
      : `p50 ${Math.round(s.latency.p50)}ms ${s.latency.p50 < 1000 ? '<' : '≥'} 1s`
  )
  parts.push(
    s.cost.n === 0
      ? 'cost no-data'
      : `mean ${usd(s.cost.mean)} ${s.cost.mean < 0.01 ? '<' : '≥'} $0.01`
  )
  return `thresholds: ${parts.join(' · ')}`
}

/** Text report — compact, monospace-safe; --json carries the same
 *  JudgeStats structure for scripting. */
export function formatStats(s: JudgeStats, opts: StatsOpts = {}): string {
  const lines: string[] = []
  const scope = [
    `${s.verdicts} verdicts${opts.replay === true ? ' (replay)' : ''}`,
    opts.since !== undefined ? `since ${opts.since}` : undefined,
    s.excluded > 0 ? `${s.excluded} ${opts.replay === true ? 'live' : 'replay'} excluded` : undefined,
    s.deduped > 0 ? `${s.deduped} deduped` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  lines.push(`judge stats — ${scope}`)
  lines.push('')

  lines.push(
    `agreement (action vs outcome): ${pct(s.agreement)} — ${s.agreement.agreed}/${s.agreement.n}` +
      (s.agreement.unscored > 0 ? ` · ${s.agreement.unscored} unscored (no outcome)` : '')
  )
  const outcomes = [
    ...new Set(Object.values(s.agreement.matrix).flatMap((r) => Object.keys(r))),
  ].sort()
  const actions = Object.keys(s.agreement.matrix).sort()
  if (actions.length > 0) {
    const w = Math.max(7, ...actions.map((a) => a.length))
    lines.push(`  ${'predicted'.padEnd(w)}  ${outcomes.map((o) => o.padStart(8)).join('')}`)
    for (const a of actions) {
      const row = s.agreement.matrix[a]!
      lines.push(
        `  ${a.padEnd(w)}  ${outcomes.map((o) => String(row[o] ?? 0).padStart(8)).join('')}`
      )
    }
  }
  const deciders = Object.entries(s.agreement.byDecider)
  if (deciders.length > 0) {
    lines.push(
      `  by decider: ${deciders
        .map(([d, t]) => `${d} ${t.agreed}/${t.n} (${pct(t)})`)
        .join(' · ')}`
    )
  }
  lines.push('')

  lines.push(
    `blocks_correctness (proxy-scored — does not count toward the bar): ${pct(s.blockingProxy)} — ${s.blockingProxy.agreed}/${s.blockingProxy.n}` +
      (s.blockingProxy.unscored > 0 ? ` · ${s.blockingProxy.unscored} unscored` : '')
  )
  lines.push('')

  lines.push('calibration (confidence × agreement):')
  for (const b of s.calibration) {
    lines.push(`  ${b.bucket}  n=${b.n}  ${pct(b)}`)
  }
  lines.push('')

  lines.push(
    `latency: n=${s.latency.n} p50=${Math.round(s.latency.p50)}ms p95=${Math.round(s.latency.p95)}ms mean=${Math.round(s.latency.mean)}ms`
  )
  const costTail = s.cost.noCost > 0 ? ` · ${s.cost.noCost} calls without cost data` : ''
  lines.push(
    `cost: n=${s.cost.n} total=${usd(s.cost.total)} mean=${usd(s.cost.mean)}${costTail}`
  )
  const pm = Object.entries(s.cost.byProviderModel).sort((a, b) => b[1].total - a[1].total)
  if (pm.length > 0) {
    lines.push('  per provider/model:')
    for (const [k, t] of pm) {
      lines.push(`    ${k}  n=${t.n} total=${usd(t.total)} mean=${usd(t.mean)}`)
    }
  }
  lines.push('')
  lines.push(thresholdLine(s))
  return lines.join('\n')
}
