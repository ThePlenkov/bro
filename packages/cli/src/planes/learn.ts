/** learn plane — the lesson store behind `bro learn probe` and
 *  `bro learn list`. The spec's closed catalog has seven planes;
 *  `learn` ships as the eighth because the MCP bead names it —
 *  descriptor-generated, same contract, no special-casing in the
 *  transport. The kv store is bd-only, so `read` rides the beads probe
 *  (specs/bro-9rls.1.md + bead bro-9rls.2). */
import {
  PlaneVerbError,
  verbsNotWired,
  type LessonRow,
  type PlaneCtx,
  type PlaneDescriptor,
} from '@broject/core'
import { getLesson, listLessons, probeQuestion, type Lesson } from '@broject/learn'
import { argNumber, argString, beadsReachable, bounded, dispatchRead, inRepo } from './helpers.ts'

const VERBS = ['capture', 'promote']

const toRow = (l: Lesson): LessonRow => ({
  id: l.id,
  ts: l.createdAt,
  summary: l.lesson,
  triggers: l.trigger.on,
  source: l.source,
  confidence: l.confidence,
})

export function learnPlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    /** `bro learn probe <question>` — the store-first query: ranked
     *  hits, gap candidates on a miss, skipped corrupt kv rows
     *  surfaced honestly. */
    probe: (a) => {
      const q = argString(a, 'question')
      if (q === undefined) {
        throw new PlaneVerbError('learn', 'probe', 'question is required')
      }
      return probeQuestion(q, { dir, limit: argNumber(a, 'limit') })
    },
  }
  return {
    name: 'learn',
    reads: Object.keys(reads),
    verbs: VERBS,
    readArgs: {
      list: { type: 'object', properties: { limit: { type: 'integer' } } },
      probe: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'the question to check the store for' },
          limit: { type: 'integer', description: 'max ranked hits' },
        },
        required: ['question'],
      },
    },
    capabilities: async () => ({
      read: inRepo(dir) && (await bounded(beadsReachable(dir), 10_000, false)),
      capture: false,
      promote: false,
    }),
    list: async (f) => {
      const { lessons } = listLessons(dir)
      const rows = lessons.map(toRow)
      const limit = typeof f?.limit === 'number' ? f.limit : undefined
      return limit === undefined ? rows : rows.slice(0, limit)
    },
    get: async (ref) => {
      const l = getLesson(ref, dir)
      return l === null ? undefined : toRow(l)
    },
    read: (name, args) => dispatchRead('learn', reads, name, args),
    exec: verbsNotWired('learn', VERBS),
  }
}
