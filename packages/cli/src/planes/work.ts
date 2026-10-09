/** work plane — the task store behind `bro status`/`bd ready`,
 *  projected through the connectors facade so `connectors.tasks`
 *  picks the backend, never this file (specs/bro-9rls.1.md). */
import {
  tasksAsync,
  verbsNotWired,
  type PlaneCtx,
  type PlaneDescriptor,
  type TaskRow,
  type TaskStoreAsync,
  type WorkItem,
} from '@broject/core'
import { collectStatus, READY_CAP } from '../commands/status.ts'
import { argNumber, bounded, dispatchRead } from './helpers.ts'

const toItem = (r: TaskRow): WorkItem => ({
  id: r.id,
  title: r.title,
  status: r.status,
  assignee: r.assignee,
  type: r.issue_type,
  priority: r.priority,
  labels: r.labels,
  parent: r.parent,
  close_reason: r.close_reason,
})

/** `bro status`'s board, field-renamed to plane vocabulary — `beads`,
 *  `drill`, `act` are backend/command nouns a client shouldn't need.
 *  The `work` section is re-sourced from the serving tasks store:
 *  `collectStatus` reads bd verbatim, so a pinned non-beads connector
 *  would otherwise show different work than list/ready serve. */
async function board(dir: string, store: TaskStoreAsync): Promise<Record<string, unknown>> {
  const s = collectStatus(dir)
  let work: unknown = s.beads
  try {
    const [inProgress, readyAll] = await Promise.all([
      store.list({ status: 'in_progress' }),
      store.ready({}),
    ])
    work = {
      inProgress: inProgress.map(toItem),
      ready: readyAll.slice(0, READY_CAP).map(toItem),
      readyTotal: readyAll.length,
    }
  } catch {
    // the board's contract is empty sections, never errors — s.beads stands
  }
  return {
    dir: s.dir,
    branch: s.branch,
    dirty: s.dirty,
    work,
    workers: s.fleet,
    frame: s.drill.frame,
    gate: s.act ?? null,
  }
}

export function workPlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const store = () => tasksAsync(dir, ctx.connectors)
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    ready: async (a) =>
      (await store().ready({ limit: argNumber(a, 'limit') })).map(toItem),
    status: () => board(dir, store()),
  }
  return {
    name: 'work',
    reads: Object.keys(reads),
    verbs: ['claim', 'close', 'reopen', 'note', 'create'],
    readArgs: {
      list: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          type: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
      ready: {
        type: 'object',
        properties: { limit: { type: 'integer' } },
      },
      status: { type: 'object', properties: {} },
    },
    /** one real ready() probe — a connector that resolves but can't
     *  answer must not advertise tools (capability ≠ configured). */
    capabilities: async () => {
      const read = await bounded(
        store()
          .ready({ limit: 1 })
          .then(() => true)
          .catch(() => false),
        10_000,
        false
      )
      return { read, claim: read, close: read, reopen: read, note: read, create: read }
    },
    list: async (f) =>
      (
        await store().list({
          status: typeof f?.status === 'string' ? f.status : undefined,
          type: typeof f?.type === 'string' ? f.type : undefined,
          all: f?.all === true,
          limit: typeof f?.limit === 'number' ? f.limit : undefined,
        })
      ).map(toItem),
    get: async (ref) => {
      const r = await store().get(ref)
      return r === undefined ? undefined : toItem(r)
    },
    read: (name, args) => dispatchRead('work', reads, name, args),
    exec: verbsNotWired('work', ['claim', 'close', 'reopen', 'note', 'create']),
  }
}
