/**
 * `task` doc type — beads issues under verb-first dispatch. The bd
 * store is the implementation; the contract is the doc layer.
 *
 *   bro list [tasks] [--status=open] [--label=x]
 *   bro show bro-n5t               ref infers the type — no noun needed
 *   bro new task "title" [--type=bug] [--priority=2]
 *   bro set bro-n5t --status=blocked
 *   bro close bro-n5t --reason="merged in #95"
 *   bro rm bro-n5t
 *   bro exec --global -- ready --json     raw bd against the store —
 *                                         escape hatch, not contract
 *
 * `--global` retargets every verb at the user-level store — scope is a
 * flag resolved at adapter construction, never a verb concern.
 */
import { spawnSync } from 'node:child_process'
import { bd, bdJson } from '@bro/core'
import type { DocAdapter, DocCtx, DocFlags, DocType } from '@bro/core'
import { requireGlobalStore } from './store.ts'

export interface TaskRow {
  id: string
  title?: string
  status?: string
  issue_type?: string
  priority?: number
  labels?: string[]
  [k: string]: unknown
}

/** The store dir this invocation targets — lazily, per verb call, so a
 *  missing global store fails only the verb that needed it. */
function storeDir(ctx: DocCtx): string {
  return ctx.scope === 'global' ? requireGlobalStore(ctx.root) : ctx.root
}

/** DocFlags → bd-style argv (`status=open` → --status open; a 'true'
 *  boolean stays a bare flag). */
function flagArgs(flags: DocFlags, skip: readonly string[] = []): string[] {
  return Object.entries(flags).flatMap(([k, v]) => {
    if (skip.includes(k)) {
      return []
    }
    return v === 'true' ? [`--${k}`] : [`--${k}`, v]
  })
}

function taskAdapter(ctx: DocCtx): DocAdapter<TaskRow> {
  const dir = () => storeDir(ctx)
  return {
    list: (flags) => bdJson<TaskRow[]>(['list', ...flagArgs(flags)], dir()),
    get: (ref) => {
      if (!ref) {
        return undefined
      }
      // bd show --json wraps the issue in an array
      const r = bdJson<TaskRow | TaskRow[]>(['show', ref], dir())
      return Array.isArray(r) ? r[0] : r
    },
    create: (input, flags) => {
      const title = input['title']
      if (typeof title !== 'string' || title === '') {
        console.error('error: bro new task needs a title — `bro new task "title"`')
        process.exit(2)
      }
      return bdJson<TaskRow>(['create', title, ...flagArgs(flags)], dir())
    },
    update: (ref, patch) => {
      if (!ref) {
        console.error('error: bro set needs a ref — `bro set <id> --status=open`')
        process.exit(2)
      }
      bd(['update', ref, ...flagArgs(patch)], dir())
      // the mutation already landed — a failed readback must not turn
      // a successful update into a reported failure
      try {
        const r = bdJson<TaskRow | TaskRow[]>(['show', ref], dir())
        return Array.isArray(r) ? r[0] : r
      } catch {
        return { id: ref }
      }
    },
    remove: (ref) => {
      if (!ref) {
        console.error('error: bro rm needs a ref — `bro rm <id>`')
        process.exit(2)
      }
      bd(['delete', ref], dir())
    },
    close: (ref: string | undefined, flags: DocFlags) => {
      if (!ref) {
        console.error('error: bro close needs a ref — `bro close <id> [--reason=…]`')
        process.exit(2)
      }
      const args = ['close', ref]
      if (flags['reason']) {
        args.push('--reason', flags['reason'])
      }
      args.push(...flagArgs(flags, ['reason']))
      bd(args, dir())
    },
    // raw passthrough — `bro exec [--global] -- <bd args>`; anything
    // after `--` reaches bd untouched. The escape hatch for bd features
    // the doc layer does not model yet.
    exec: (_ref: string | undefined, _flags: DocFlags, positional: string[]) => {
      const res = spawnSync('bd', positional, { cwd: dir(), stdio: 'inherit' }) // NOSONAR — PATH contract
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
