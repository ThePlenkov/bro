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

export function groupStats(records: DebtRecord[], by: StatsGroupBy): StatBucket[] {
  const buckets = new Map<string, StatBucket>()
  for (const r of records) {
    // legacy rows predate `source` — they belong to review-threads
    const key = by === 'source' ? (r.source ?? 'review-threads') : r[by]
    let b = buckets.get(key)
    if (!b) {
      b = { key, total: 0, open: 0, claimed: 0, done: 0, wontfix: 0, duplicate: 0, fixRate: null }
      buckets.set(key, b)
    }
    b.total += 1
    b[r.status] += 1
  }
  const out = [...buckets.values()]
  for (const b of out) {
    const decided = b.done + b.wontfix + b.duplicate
    b.fixRate = decided > 0 ? b.done / decided : null
  }
  return out.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
}
