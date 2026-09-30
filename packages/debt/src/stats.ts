/**
 * Signal metrics over the ledger — which reviewer (or source, or area)
 * produces findings that get fixed vs dismissed. `fixRate` counts only
 * decided rows (done / wontfix / duplicate): open and claimed are still
 * undecided, so a reviewer with 100 open findings has no rate yet, not 0%.
 */
import type { DebtRecord } from './types.ts'

export type StatsGroupBy = 'author' | 'source' | 'area'

export interface StatBucket {
  key: string
  total: number
  open: number
  claimed: number
  done: number
  wontfix: number
  duplicate: number
  /** done / (done + wontfix + duplicate); null until something is decided */
  fixRate: number | null
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'claimed',
  'done',
  'wontfix',
  'duplicate',
])

/** The grouping key for one record — shared by stats and trend so both
 *  views bucket a row the same way. Legacy rows predate `source` — they
 *  belong to review-threads; ledger is unvalidated JSONL, so author/area
 *  can be missing too. */
export function groupKey(r: DebtRecord, by: StatsGroupBy): string {
  const raw = by === 'source' ? (r.source ?? 'review-threads') : r[by]
  return raw || 'unknown'
}

export function groupStats(records: DebtRecord[], by: StatsGroupBy): StatBucket[] {
  const buckets = new Map<string, StatBucket>()
  for (const r of records) {
    const key = groupKey(r, by)
    let b = buckets.get(key)
    if (!b) {
      b = { key, total: 0, open: 0, claimed: 0, done: 0, wontfix: 0, duplicate: 0, fixRate: null }
      buckets.set(key, b)
    }
    b.total += 1
    // an unrecognized status counts toward total but no bucket — b[status]
    // unchecked would write NaN into a field that isn't part of the shape
    if (KNOWN_STATUSES.has(r.status)) {
      b[r.status as keyof Pick<StatBucket, 'open' | 'claimed' | 'done' | 'wontfix' | 'duplicate'>] += 1
    }
  }
  const out = [...buckets.values()]
  for (const b of out) {
    const decided = b.done + b.wontfix + b.duplicate
    b.fixRate = decided > 0 ? b.done / decided : null
  }
  return out.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
}
