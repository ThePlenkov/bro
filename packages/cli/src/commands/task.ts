/**
 * `bro task` — the task store facade so runbooks (and dogfood
 * scenarios) never name the backend binary. Thin over
 * `taskStore()` — the same store `bro next`, `bro work enter` and the
 * SDD gate read; backend selection (`tasks.backend`) applies here too.
 *
 *   bro task new <title> [-d desc] [--priority N] [--type T]
 *                        [--label L]…       create, print the new id
 *   bro task desc <id> <text…>             set the description verbatim —
 *                        the `spec:` link the SDD gate reads lives here
 *   bro task show <id> [--json]            one row, all fields
 *   bro task list [--ready] [--json]       the queue (--ready = claimable)
 *   bro task claim <id>                    atomic assignee + in_progress
 *   bro task close <id> [reason…]          close with optional reason
 *   bro task note <id> <text…>             append a note
 */
import { taskStore, type TaskRow } from '@broject/core'
import { flag, flagAll, positionals } from './args.ts'

function usage(): never {
  console.error(`usage:
  bro task new <title> [-d desc] [--priority N] [--type T] [--label L]…
  bro task desc <id> <text…>
  bro task show <id> [--json]
  bro task list [--ready] [--json]
  bro task claim <id>
  bro task close <id> [reason…]
  bro task note <id> <text…>`)
  process.exit(2)
}

function printRow(r: TaskRow): void {
  const tags =
    r.labels !== undefined && r.labels.length > 0 ? ` [${r.labels.join(',')}]` : ''
  console.log(
    `${r.id}\t${r.status ?? '-'}\t${r.assignee ?? '-'}\t${r.title ?? ''}${tags}`
  )
}

function cmdNew(rest: string[]): void {
  const pos = positionals(rest, new Set(['-d', '--description', '--priority', '--type', '--label']))
  const title = pos.join(' ').trim()
  if (title === '') usage()
  const prRaw = flag(rest, '--priority')
  const patch: Parameters<ReturnType<typeof taskStore>['create']>[0] = { title }
  const desc = flag(rest, '-d') ?? flag(rest, '--description')
  if (desc !== undefined) patch.description = desc
  if (prRaw !== undefined) {
    const p = Number(prRaw)
    if (!Number.isInteger(p)) {
      console.error(`error: --priority needs an integer, got "${prRaw}"`)
      process.exit(2)
    }
    patch.priority = p
  }
  const type = flag(rest, '--type')
  if (type !== undefined) patch.type = type
  const labels = flagAll(rest, '--label')
  if (labels.length > 0) patch.labels = labels
  const row = taskStore().create(patch)
  console.log(row.id)
}

function cmdDesc(rest: string[]): void {
  const pos = positionals(rest, new Set(), { strict: true })
  const [id, ...words] = pos
  if (id === undefined || words.length === 0) usage()
  taskStore().update(id, { description: words.join(' ') })
  console.log(id)
}

function cmdShow(rest: string[]): void {
  const pos = positionals(rest, new Set(), { boolFlags: new Set(['--json']), strict: true })
  const id = pos[0]
  if (id === undefined || pos.length > 1) usage()
  const row = taskStore().get(id)
  if (row === undefined) {
    console.error(`error: no such task: ${id}`)
    process.exit(1)
  }
  if (rest.includes('--json')) {
    console.log(JSON.stringify(row, null, 2))
    return
  }
  printRow(row)
  if (row.description !== undefined && row.description !== '') {
    console.log(row.description)
  }
}

function cmdList(rest: string[]): void {
  positionals(rest, new Set(), { boolFlags: new Set(['--ready', '--json']), strict: true })
  const store = taskStore()
  const rows = rest.includes('--ready') ? store.ready() : store.list()
  if (rest.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  for (const r of rows) printRow(r)
}

function oneId(rest: string[], minTail = 0): { id: string; tail: string[] } {
  const pos = positionals(rest, new Set(), { strict: true })
  const [id, ...tail] = pos
  if (id === undefined || tail.length < minTail) {
    usage()
  }
  return { id, tail }
}

export async function runTaskCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (sub === '--help' || sub === '-h' || sub === undefined) usage()
  switch (sub) {
    case 'new':
      cmdNew(rest)
      return
    case 'desc':
      cmdDesc(rest)
      return
    case 'show':
      cmdShow(rest)
      return
    case 'list':
      cmdList(rest)
      return
    case 'claim': {
      const { id, tail } = oneId(rest)
      if (tail.length > 0) usage()
      taskStore().claim(id)
      console.log(id)
      return
    }
    case 'close': {
      const { id, tail } = oneId(rest)
      taskStore().close(id, tail.length > 0 ? tail.join(' ') : undefined)
      console.log(id)
      return
    }
    case 'note': {
      const { id, tail } = oneId(rest, 1)
      taskStore().note(id, tail.join(' '))
      console.log(id)
      return
    }
    default:
      console.error(`error: unknown subcommand ${sub}`)
      usage()
  }
}
