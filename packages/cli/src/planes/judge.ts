/** judge plane — the verdicts journal + stats behind `bro judge`.
 *  Rows are keyed by append-only read-order index — a threadId recurs
 *  whenever a subject is re-judged (fresh commentSha/headSha), so it
 *  is never a unique key. */
import {
  verbsNotWired,
  type JournalRow,
  type PlaneCtx,
  type PlaneDescriptor,
  type Verdict,
  type VerdictRow,
} from '@broject/core'
import { computeStats, journalPath, judgeFacade, readJournal } from '@broject/judge'
import { argString, dispatchRead } from './helpers.ts'

const VERBS = ['decide']

const rowKey = (_r: JournalRow, i: number): string => `row:${i}`

/** journal.ts/stats.ts's own predicate — Verdict.kind is `string`, so
 *  the union narrows only through a guard, never a bare !== check. */
const isVerdict = (r: JournalRow): r is Verdict => r.kind !== 'act-disposition'

const toRow = (r: JournalRow, i: number): VerdictRow => {
  const base: VerdictRow = {
    id: rowKey(r, i),
    ts: r.ts,
    kind: r.kind,
    subject: r.subject,
    outcome: r.outcome,
  }
  if (isVerdict(r)) {
    base.model = r.model
    base.lowConfidence = r.lowConfidence
  }
  return base
}

export function judgePlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const rows = (): JournalRow[] => readJournal(dir)
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    /** `bro judge stats` — agreement/accuracy rollups over the journal. */
    stats: (a) => {
      const since = argString(a, 'since')
      return computeStats(rows(), since === undefined ? {} : { since })
    },
  }
  return {
    name: 'judge',
    reads: Object.keys(reads),
    verbs: VERBS,
    readArgs: {
      list: { type: 'object', properties: { limit: { type: 'integer' } } },
      stats: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO timestamp — verdicts older than this are excluded' },
        },
      },
    },
    /** `canDecide` = a provider resolves (registry or synthesized
     *  legacy entry) — configured is not capable; `read` = a journal
     *  path exists (verdicts may be empty — that's a valid ledger). */
    capabilities: async () => {
      let decide = false
      try {
        judgeFacade(dir)
        decide = true
      } catch {
        decide = false
      }
      return { read: journalPath(dir) !== null, decide }
    },
    list: async (f) => {
      const all = rows().map((r, i) => toRow(r, i))
      const limit = typeof f?.limit === 'number' ? f.limit : undefined
      return limit === undefined ? all : all.slice(-limit)
    },
    get: async (ref) =>
      rows()
        .map((r, i) => toRow(r, i))
        .find((r) => r.id === ref),
    read: (name, args) => dispatchRead('judge', reads, name, args),
    exec: verbsNotWired('judge', VERBS),
  }
}
