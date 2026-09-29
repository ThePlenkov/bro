/**
 * `task` doc type — the issue-level store under noun-first dispatch.
 * All backend access goes through the TaskStore contract
 * (@broject/core/tasks.ts); this file only maps CLI flags onto it.
 *
 *   bro task list [--status=open] [--label=x]
 *   bro task show bro-n5t               shorthand: `bro show …`
 *   bro task new "title" [--type=bug] [--priority=2]
 *   bro task set bro-n5t --status=blocked
 *   bro task close bro-n5t --reason="merged in #95"
 *   bro task rm bro-n5t
 *   bro task exec --global -- ready --json   raw bd against the store —
 *                                            escape hatch, not contract
 *
 * `--global` retargets every verb at the user-level store — scope is a
 * flag resolved at adapter construction, never a verb concern.
 */
import { spawnSync } from 'node:child_process'
import { facade } from '@broject/core'
import type { DocAdapter, DocCtx, DocFlags, DocType, TaskFilter, TaskInput, TaskRow, TaskStore } from '@broject/core'
import { requireGlobalStore } from './store.ts'
import { loadBroConfig } from '../plugins.ts'

export type { TaskRow }

/** The store this invocation targets — lazily, per verb call, so a
 *  missing global store fails only the verb that needed it. Resolved
 *  through the connector registry: `connectors.tasks` in bro.config
 *  can point the whole surface at another work-item system. */
function storeFor(ctx: DocCtx): () => TaskStore {
  const dir = () => (ctx.scope === 'global' ? requireGlobalStore(ctx.root) : ctx.root)
  return () =>
    facade('tasks', { dir: dir() }, { prefer: loadBroConfig(ctx.root).connectors })
}

/** CLI flags → TaskFilter — known keys map, the rest are ignored
 *  (the store contract is typed; arbitrary backend flags go through
 *  `exec`). */
function toFilter(flags: DocFlags): TaskFilter {
  const f: TaskFilter = {}
  if (flags['status']) f.status = flags['status']
  if (flags['type']) f.type = flags['type']
  if (flags['all'] === 'true') f.all = true
  const limit = flags['limit'] ?? flags['n']
  if (limit) f.limit = Number(limit)
  const label = flags['label'] ?? flags['l']
  if (label) f.labels = label.split(',')
  const exclude = flags['exclude-label']
  if (exclude) f.excludeLabels = exclude.split(',')
  return f
}

/** CLI flags → TaskInput — everything the dispatcher didn't consume
 *  as the title. */
function toInput(input: Record<string, unknown>, flags: DocFlags): TaskInput {
  const i: TaskInput = { title: '' }
  if (typeof input['title'] === 'string') i.title = input['title']
  if (flags['type']) i.type = flags['type']
  if (flags['priority']) i.priority = Number(flags['priority'])
  if (flags['description']) i.description = flags['description']
  if (flags['label']) i.labels = flags['label'].split(',')
  if (flags['deps']) i.deps = flags['deps'].split(',')
  if (flags['parent']) i.parent = flags['parent']
  if (flags['external-ref']) i.externalRef = flags['external-ref']
  if (flags['ephemeral'] === 'true') i.ephemeral = true
  if (flags['no-inherit-labels'] === 'true') i.noInheritLabels = true
  if (flags['metadata']) {
    try {
      i.metadata = JSON.parse(flags['metadata']) as Record<string, unknown>
    } catch {
      i.metadata = { value: flags['metadata'] }
    }
  }
  return i
}

function taskAdapter(ctx: DocCtx): DocAdapter<TaskRow> {
  const store = storeFor(ctx)
  const die = (msg: string): never => {
    console.error(`error: ${msg}`)
    process.exit(2)
  }
  return {
    list: (flags) => store().list(toFilter(flags)),
    get: (ref) => (ref ? store().get(ref) : undefined),
    create: (input, flags) => {
      const i = toInput(input, flags)
      if (i.title === '') {
        die('bro task new needs a title — `bro task new "title"`')
      }
      return store().create(i)
    },
    update: (ref, patch) => {
      if (!ref) {
        die('bro task set needs a ref — `bro task set <id> --status=open`')
      }
      const s = store()
      s.update(ref, patch)
      // the mutation already landed — a failed readback must not turn
      // a successful update into a reported failure
      try {
        return s.get(ref)
      } catch {
        return { id: ref }
      }
    },
    remove: (ref) => {
      if (!ref) {
        die('bro task rm needs a ref — `bro task rm <id>`')
      }
      store().remove(ref)
    },
    close: (ref: string | undefined, flags: DocFlags) => {
      const id = ref ?? die('bro task close needs a ref — `bro task close <id> [--reason=…]`')
      store().close(id, flags['reason'])
    },
    // raw passthrough — `bro task exec [--global] -- <bd args>`;
    // anything after `--` reaches bd untouched. The escape hatch for
    // bd features the store contract does not model yet.
    exec: (_ref: string | undefined, _flags: DocFlags, positional: string[]) => {
      const dir = ctx.scope === 'global' ? requireGlobalStore(ctx.root) : ctx.root
      const res = spawnSync('bd', positional, { cwd: dir, stdio: 'inherit' }) // NOSONAR — PATH contract
      process.exit(res.status ?? 1)
    },
  }
}

export const taskDoc: DocType<TaskRow> = {
  name: 'task',
  aliases: ['tasks', 'bead', 'beads', 'issue'],
  scopes: ['project', 'global'],
  render(t) {
    const kind = t.issue_type ? ` ${t.issue_type}` : ''
    const title = (t.title ?? '').replace(/\s+/g, ' ').slice(0, 80)
    return `${t.id}  [${t.status ?? '?'}${kind}]  ${title}`
  },
  adapter: taskAdapter,
}
