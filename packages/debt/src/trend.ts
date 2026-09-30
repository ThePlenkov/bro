/**
 * Burn-down over the ledger — open findings per time bucket, optionally
 * split by the same keys `stats` groups on.
 *
 * Each finding contributes an open interval [firstSeen, closedAt):
 * firstSeen is the earliest harvest snapshot containing the thread (the
 * merged row's `harvested_at` is the *latest* sighting — the wrong edge
 * for "debt incurred"), closedAt is the overlay's `fixed_at`. Overlays
 * are single-value, so a close→reopen cycle collapses to the latest
 * stamps — approximation, not event sourcing.
 */
import { groupKey, type StatsGroupBy } from './stats.ts'
import type { DebtRecord } from './types.ts'

export type TrendGranularity = 'day' | 'week'

export interface TrendPoint {
  /** Bucket start — YYYY-MM-DD, UTC (weeks start Monday). */
  bucket: string
  /** Group key — 'all' when ungrouped. */
  key: string
  /** Findings whose open interval started inside this bucket. */
  opened: number
  /** Findings whose open interval ended inside this bucket. */
  closed: number
  /** Open at bucket end — the in-progress bucket counts at `now`. */
  open: number
}

/** First/last harvest observation per thread — see readThreadBounds. */
export type ThreadBounds = Map<string, { first: string; last: string }>

export interface TrendOptions {
  /** Grouping key — null renders a single 'all' series. */
  by: StatsGroupBy | null
  /** Bucket granularity (default 'week'). */
  granularity?: TrendGranularity
  /** ISO date/datetime — buckets starting before it are dropped. */
  since?: string | null
  /** Right edge of the series — injectable for tests. */
  now?: Date
}

const DAY_MS = 86_400_000

// decided rows: done/wontfix always stamp fixed_at; pre-existing
// duplicate overlays don't — for those the last sighting is the honest
// close edge (the thread was still open when last observed).
const DECIDED: ReadonlySet<string> = new Set(['done', 'wontfix', 'duplicate'])

function parseTime(s: string | null | undefined): number | null {
  if (typeof s !== 'string' || s === '') {
    return null
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function dayStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function bucketStart(ms: number, g: TrendGranularity): number {
  if (g === 'day') {
    return dayStart(ms)
  }
  // ISO week is Monday-start: getUTCDay() runs Sun=0..Sat=6, so shift the
  // week's days back to the preceding Monday.
  const start = dayStart(ms)
  return start - ((new Date(start).getUTCDay() + 6) % 7) * DAY_MS
}

function bucketEnd(start: number, g: TrendGranularity): number {
  return start + (g === 'day' ? DAY_MS : 7 * DAY_MS)
}

function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

interface Span {
  /** Interval start (epoch ms) — -Infinity when no timestamp parses:
   *  undatable debt is conservatively "open since before the series". */
  start: number
  /** Interval end — null while the finding is undecided/open. */
  end: number | null
  key: string
}

function spanFor(r: DebtRecord, bounds: ThreadBounds, by: StatsGroupBy | null): Span {
  const b = bounds.get(r.thread_id)
  const start = parseTime(b?.first) ?? parseTime(r.harvested_at) ?? Number.NEGATIVE_INFINITY
  let end = parseTime(r.fixed_at)
  if (end === null && DECIDED.has(r.status)) {
    end = parseTime(b?.last) ?? parseTime(r.harvested_at)
  }
  // A close stamp before the open edge (clock skew, backfilled overlay)
  // clamps to a zero-length interval rather than a negative span.
  if (end !== null && end < start) {
    end = start
  }
  return { start, end, key: by === null ? 'all' : groupKey(r, by) }
}

export function buildTrend(
  records: DebtRecord[],
  bounds: ThreadBounds,
  opts: TrendOptions
): TrendPoint[] {
  const g = opts.granularity ?? 'week'
  const now = (opts.now ?? new Date()).getTime()
  const spans = records.map((r) => spanFor(r, bounds, opts.by))
  if (spans.length === 0) {
    return []
  }

  // Range: earliest datable open edge → the bucket containing now. A
  // --since in the future yields an empty series, not a clamped lie.
  const datable = spans.filter((s) => Number.isFinite(s.start))
  let t0 = datable.length > 0 ? bucketStart(Math.min(...datable.map((s) => s.start)), g) : bucketStart(now, g)
  const since = parseTime(opts.since)
  if (since !== null) {
    t0 = Math.max(t0, bucketStart(since, g))
  }
  const tEnd = bucketStart(now, g)
  if (t0 > tEnd) {
    return []
  }

  // Group ordering follows stats: record count desc, key asc on ties.
  const byKey = new Map<string, Span[]>()
  for (const s of spans) {
    const ks = byKey.get(s.key)
    if (ks) {
      ks.push(s)
    } else {
      byKey.set(s.key, [s])
    }
  }
  const keys = [...byKey.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([k]) => k)

  const points: TrendPoint[] = []
  for (let b = t0; b <= tEnd; b = bucketEnd(b, g)) {
    const end = bucketEnd(b, g)
    const cutoff = Math.min(end, now)
    for (const key of keys) {
      const ks = byKey.get(key)!
      points.push({
        bucket: fmt(b),
        key,
        opened: ks.filter((s) => s.start >= b && s.start < end).length,
        closed: ks.filter((s) => s.end !== null && s.end >= b && s.end < end).length,
        open: ks.filter((s) => s.start <= cutoff && (s.end === null || s.end > cutoff)).length,
      })
    }
  }
  return points
}
