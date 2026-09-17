/**
 * `bro drill <sub>` — scoped descent over beads. Frames are issues labeled
 * `drill`; bd owns storage, bro owns the invariants (mandatory result +
 * prevention memo on the way up).
 *
 *   down <title> [--under ID] [--ephemeral]   descend into a narrower frame
 *   up --result T [--prevent T]… [--evidence R]…   ascend, hand result to parent
 *   current                                   active leaf frame
 *   tree                                      all drill trees
 *   list                                      open frames
 *   distill ID                                bd mol distill: tree → proto
 */
import {
  checkBeads,
  currentFrame,
  drillDown,
  drillTree,
  drillUp,
  listDrills,
  bd,
} from '@bro/drill'
import { flag, flagAll, positionals } from './args.ts'

/** Flags that consume the next arg as their value. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--under',
  '--result',
  '--prevent',
  '--evidence',
  '--type',
  '--priority',
  '--description',
  '--id',
])

const drillPositionals = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

function usage(): never {
  console.error(`Usage: bro drill <command> [args…]

Commands:
  down <title> [--under ID] [--ephemeral]        New child frame under current leaf (or root)
  up --result T [--prevent T]… [--evidence R]…   Close current frame, memo goes to beads
  current                                        Show the active leaf frame
  tree                                           Render all drill hierarchies
  list                                           Open drill frames
  distill ID                                     Extract a reusable proto from a drill epic

  bro unwind …                                   alias for \`bro drill up\``)
  process.exit(1)
}

function parsePriority(raw: string | undefined): number | undefined {
  const priority = raw ? Number(raw) : undefined
  if (raw !== undefined && (raw.trim() === '' || !Number.isInteger(priority))) {
    console.error(`error: --priority must be an integer, got "${raw}"`)
    process.exit(2)
  }
  return priority
}

function cmdDown(rest: string[]): void {
  const title = drillPositionals(rest).join(' ')
  if (!title?.trim()) {
    console.error('error: drill down requires a title')
    process.exit(2)
  }
  const row = drillDown(title, {
    under: flag(rest, '--under'),
    ephemeral: rest.includes('--ephemeral'),
    type: flag(rest, '--type'),
    priority: parsePriority(flag(rest, '--priority')),
    description: flag(rest, '--description'),
  })
  console.log(`drill ↓ ${row.id} ${row.title}`)
}

function cmdUp(rest: string[]): void {
  const result = flag(rest, '--result')
  if (!result) {
    console.error('error: drill up requires --result — a frame must return a curated finding')
    process.exit(2)
  }
  const res = drillUp({
    id: flag(rest, '--id'),
    result,
    prevent: flagAll(rest, '--prevent'),
    evidence: flagAll(rest, '--evidence'),
  })
  console.log(`drill ↑ ${res.closed} closed`)
  for (const id of res.preventionIds) {
    console.log(`  prevention → ${id}`)
  }
}

function cmdCurrent(): void {
  const frame = currentFrame()
  if (!frame) {
    console.log('no open drill frame')
    process.exitCode = 1
    return
  }
  const parent = frame.parentId ? ` parent=${frame.parentId}` : ''
  console.log(`${frame.id} ${frame.title} [depth=${frame.depth}${parent}]`)
}

function cmdList(): void {
  const rows = listDrills().filter((r) => r.status !== 'closed' && r.status !== 'done')
  if (rows.length === 0) {
    console.log('no open drill frames')
    return
  }
  for (const row of rows) {
    console.log(`${row.id}\t${row.status}\t${row.title}`)
  }
}

/** A misspelled option must fail loudly, not dissolve into a title. */
const KNOWN_FLAGS: Record<string, Set<string>> = {
  down: new Set(['--under', '--ephemeral', '--type', '--priority', '--description']),
  up: new Set(['--id', '--result', '--prevent', '--evidence']),
  current: new Set(),
  tree: new Set(),
  list: new Set(),
  distill: new Set(),
}

function rejectUnknownFlags(sub: string, argv: string[]): void {
  const known = KNOWN_FLAGS[sub]
  if (!known) {
    return
  }
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) {
      console.error(`error: unknown option "${arg}" for drill ${sub}`)
      process.exit(2)
    }
  }
}

export async function runDrillCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') {
    usage()
  }
  checkBeads()
  rejectUnknownFlags(sub, rest)
  // these subs take no positional args — a stray one is a typo, not input
  const noPositionals = new Set(['up', 'current', 'tree', 'list'])
  const extras = drillPositionals(rest)
  if (noPositionals.has(sub) && extras.length > 0) {
    console.error(`error: unexpected argument "${extras[0]}"`)
    process.exit(2)
  }

  switch (sub) {
    case 'down':
      cmdDown(rest)
      return
    case 'up':
      cmdUp(rest)
      return
    case 'current':
      cmdCurrent()
      return
    case 'tree':
      console.log(drillTree())
      return
    case 'list':
      cmdList()
      return
    case 'distill': {
      const ids = drillPositionals(rest)
      if (ids.length !== 1) {
        console.error('error: drill distill requires exactly one epic/bead id')
        process.exit(2)
      }
      const id = ids[0]!
      process.stdout.write(bd(['mol', 'distill', id]))
      return
    }
    default:
      usage()
  }
}
