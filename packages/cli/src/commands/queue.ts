/**
 * `bro queue` — the frame's intake queue (bro-oy3k1.2). Items are beads;
 * membership and rank are labels, so the queue survives sync and needs
 * no second store. A queued item promotes into a drill frame.
 *
 *   bro queue <subject…>            enqueue under the current frame
 *   bro queue ls [--under F]        rank order listing
 *   bro queue drill <id>            promote item → drill frame (push)
 *   bro queue bump <id> [--to N]    reprioritize (bare = float to top)
 *   bro queue rm <id>               dequeue (bead stays open)
 */
import { checkBeads, queueAdd, queueBump, queueDrill, queueDrop, queueItems, queueScope } from '@broject/drill'
import { flag, positionals } from './args.ts'

const VALUE_FLAGS = new Set(['--under', '--to', '--description', '--priority'])
const positionalsOf = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

function usage(exitCode = 1): never {
  console.error(`Usage: bro queue <command> [args…]

Commands:
  bro queue <subject…>      Enqueue an item on the current frame's queue
  ls [--under F]            List the frame's queue in rank order
  drill <id>                Promote a queued item into a drill frame
  bump <id> [--to N]        Reprioritize — bare bump floats to top
  rm <id> [--under F]       Dequeue — the bead stays open

Scope: the current drill frame, else the session queue (root).`)
  process.exit(exitCode)
}

function needId(rest: string[], sub: string): string {
  const ids = positionalsOf(rest)
  if (ids.length !== 1) {
    console.error(`error: queue ${sub} requires exactly one bead id`)
    process.exit(2)
  }
  return ids[0] as string
}

/** An integer flag or a syntax error — never a silent NaN. */
function intFlag(argv: string[], name: string): number | undefined {
  const raw = flag(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) {
    console.error(`error: ${name} must be an integer, got "${raw}"`)
    process.exit(2)
  }
  return n
}

function run(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

function cmdLs(rest: string[]): void {
  const frame = queueScope(flag(rest, '--under'))
  const items = queueItems(frame)
  if (items.length === 0) {
    console.log(`queue ${frame}: empty`)
    return
  }
  console.log(`queue ${frame}:`)
  for (const i of items) console.log(`  ${i.rank}\t${i.id}\t${i.title}`)
}

function cmdDrill(rest: string[]): void {
  const id = needId(rest, 'drill')
  run(() => {
    const { frame } = queueDrill(id)
    console.log(`drill ↓ ${frame.id} ${frame.title}`)
  })
}

function cmdBump(rest: string[]): void {
  const id = needId(rest, 'bump')
  const to = intFlag(rest, '--to')
  run(() => {
    const rank = queueBump(id, { under: flag(rest, '--under'), to })
    console.log(`${id} → rank ${rank}`)
  })
}

function cmdRm(rest: string[]): void {
  const id = needId(rest, 'rm')
  run(() => {
    queueDrop(id, { under: flag(rest, '--under') })
    console.log(`dequeued ${id}`)
  })
}

function cmdIntake(words: string[]): void {
  const priority = intFlag(words, '--priority')
  run(() => {
    const { row, frame, rank } = queueAdd(positionalsOf(words).join(' '), {
      under: flag(words, '--under'),
      description: flag(words, '--description'),
      priority,
    })
    console.log(`queued ${row.id} → ${frame} rank ${rank}`)
  })
}

export function runQueueCommand(argv: string[]): void {
  const [sub, ...rest] = argv
  if (sub === '--help' || sub === '-h') usage(0)
  const subs = new Set(['ls', 'drill', 'bump', 'rm', 'add'])
  // bare `bro queue` lists; `bro queue <subject>` is intake; unknown
  // dash-flags are typos, not subjects
  if (sub !== undefined && !subs.has(sub) && sub.startsWith('-')) {
    console.error(`error: unknown option "${sub}"`)
    process.exit(2)
  }
  checkBeads()

  switch (sub) {
    case undefined:
    case 'ls':
      cmdLs(rest)
      return
    case 'drill':
      cmdDrill(rest)
      return
    case 'bump':
      cmdBump(rest)
      return
    case 'rm':
      cmdRm(rest)
      return
    // intake: `queue <subject…>` or `queue add <subject…>`
    case 'add':
      cmdIntake(rest)
      return
    default:
      cmdIntake(argv)
  }
}
