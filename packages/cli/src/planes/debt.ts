/** debt plane — the review-debt ledger behind `bro debt next` and
 *  `bro debt summary`. Rows are Finding keyed on thread_id; a missing
 *  ledger is an empty store (valid zero), never an unavailable one
 *  (specs/bro-9rls.1.md). */
import {
  verbsNotWired,
  type Finding,
  type PlaneCtx,
  type PlaneDescriptor,
} from '@broject/core'
import { buildSummary, readDebtRecords, type DebtRecord } from '@broject/debt'
import { argString, dispatchRead } from './helpers.ts'

const VERBS = ['collect', 'set']

/** cmdNext's ranking — priority first, oldest within a tier. Kept in
 *  lockstep with commands/debt.ts: the plane never invents its own
 *  ordering, it re-reads the command's rule. */
const PRIORITY_RANK: Record<DebtRecord['priority'], number> = {
  blocking: 0,
  human: 1,
  nit: 2,
  scan: 3,
  noise: 4,
}

const toFinding = (r: DebtRecord): Finding => ({
  id: r.thread_id,
  pr: r.source_pr,
  url: r.thread_url,
  status: r.status,
  priority: r.priority,
  needs: r.needs,
  path: r.path,
  line: r.line,
  author: r.author,
  area: r.area,
  preview: r.body_preview,
  harvested_at: r.harvested_at,
  fix_pr: r.fix_pr,
  fixed_at: r.fixed_at,
})

const openRank = (a: DebtRecord, b: DebtRecord): number =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  a.harvested_at.localeCompare(b.harvested_at)

export function debtPlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const records = () => readDebtRecords(dir)
  const filtered = (a?: Record<string, unknown>): Finding[] => {
    const status = argString(a, 'status')
    const area = argString(a, 'area')
    const author = argString(a, 'author')
    return records()
      .filter(
        (r) =>
          (status === undefined || r.status === status) &&
          (area === undefined || r.area === area) &&
          (author === undefined || r.author === author)
      )
      .map(toFinding)
  }
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    /** `bro debt next` (without --claim) — the top open finding under
     *  the command's ranking, or null when the ledger has none. */
    next: (a) => {
      const area = argString(a, 'area')
      const author = argString(a, 'author')
      const row = records()
        .filter((r) => r.status === 'open')
        .filter((r) => (area === undefined || r.area === area) && (author === undefined || r.author === author))
        .sort(openRank)[0]
      return row === undefined ? null : toFinding(row)
    },
    /** `bro debt summary` — the ledger rollup the command prints. */
    summary: () => buildSummary(records()),
  }
  return {
    name: 'debt',
    reads: Object.keys(reads),
    verbs: VERBS,
    readArgs: {
      list: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          area: { type: 'string' },
          author: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
      next: {
        type: 'object',
        properties: { area: { type: 'string' }, author: { type: 'string' } },
      },
      summary: { type: 'object', properties: {} },
    },
    capabilities: async () => ({ read: true, collect: false, set: false }),
    list: async (f) => {
      const rows = filtered(f)
      const limit = typeof f?.limit === 'number' ? f.limit : undefined
      return limit === undefined ? rows : rows.slice(0, limit)
    },
    get: async (ref) => records().map(toFinding).find((r) => r.id === ref),
    read: (name, args) => dispatchRead('debt', reads, name, args),
    exec: verbsNotWired('debt', VERBS),
  }
}
