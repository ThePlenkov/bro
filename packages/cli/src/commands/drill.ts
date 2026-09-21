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
  type DrillPlan,
} from '@bro/drill'
import { flag, flagAll, positionals } from './args.ts'

function usage(exitCode = 1): never {
  console.error(`Usage: bro drill <command> [args…]

Commands:
  down <title> [--under ID] [--ephemeral]        New child frame under current leaf (or root)
  up --result T [--prevent T]… [--evidence R]…   Close current frame, memo goes to beads
  current                                        Show the active leaf frame
  tree                                           Render all drill hierarchies
  list                                           Open drill frames
  distill ID                                     Extract a reusable proto from a drill epic

  bro unwind …                                   alias for \`bro drill up\``)
  process.exit(exitCode)
}

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

function parsePriority(raw: string | undefined): number | undefined {
  const priority = raw ? Number(raw) : undefined
  if (raw !== undefined && (raw.trim() === '' || !Number.isInteger(priority))) {
    console.error(`error: --priority must be an integer, got "${raw}"`)
    process.exit(2)
  }
  return priority
}

// parse* helpers are pure validation + extraction — they run before
// checkBeads() so a syntax error always beats a beads setup error.

function parseDown(rest: string[]) {
  const title = drillPositionals(rest).join(' ')
  if (!title?.trim()) {
    console.error('error: drill down requires a title')
    process.exit(2)
  }
  return {
    title,
    opts: {
      under: flag(rest, '--under'),
      ephemeral: rest.includes('--ephemeral'),
      type: flag(rest, '--type'),
      priority: parsePriority(flag(rest, '--priority')),
      description: flag(rest, '--description'),
    },
  }
}

function parseUp(rest: string[]) {
  const result = flag(rest, '--result')
  if (!result) {
    console.error('error: drill up requires --result — a frame must return a curated finding')
    process.exit(2)
  }
  return {
    id: flag(rest, '--id'),
    result,
    prevent: flagAll(rest, '--prevent'),
    evidence: flagAll(rest, '--evidence'),
  }
}

function parseDistill(rest: string[]): string {
  const ids = drillPositionals(rest)
  if (ids.length !== 1) {
    console.error('error: drill distill requires exactly one epic/bead id')
    process.exit(2)
  }
  return ids[0]!
}

function cmdDown(rest: string[]): void {
  const { title, opts } = parseDown(rest)
  const row = drillDown(title, opts)
  console.log(`drill ↓ ${row.id} ${row.title}`)
}

/** Materialize a drill plan (`bro run drill.toml`): the root frame plus
 *  declared child steps as open beads — investigation then fills each
 *  with `drill up --result` as usual. The root is a root — a plan never
 *  grafts onto whatever leaf happens to be open. bd has no transactions,
 *  so a mid-flight failure deletes the frames this run created (the
 *  claimFrame/drillUp convention): a retry converges instead of
 *  duplicating the tree. */
export function applyDrillPlan(plan: DrillPlan): void {
  checkBeads()
  const created: string[] = []
  try {
    const root = drillDown(plan.title, { root: true })
    created.push(root.id)
    console.log(`drill ↓ ${root.id} ${root.title} (plan root)`)
    const ids = new Map<number, string>()
    plan.steps.forEach((s, i) => {
      const under = s.under === undefined ? root.id : ids.get(s.under)
      if (under === undefined) {
        throw new Error(`steps[${i}]: under=${s.under} has no materialized step`)
      }
      const row = drillDown(s.title, {
        under,
        ephemeral: s.ephemeral,
        description: s.description,
        priority: s.priority,
        type: s.type,
      })
      created.push(row.id)
      ids.set(i, row.id)
      console.log(`  step → ${row.id} ${row.title}`)
    })
  } catch (err) {
    const orphans: string[] = []
    // children first — bd refuses to delete a frame with open children
    for (const id of [...created].reverse()) {
      try {
        bd(['delete', id, '--force'])
      } catch {
        orphans.push(id)
      }
    }
    if (orphans.length === 0) {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${msg} — cleanup incomplete: frame(s) left behind: ${orphans.join(', ')}`,
      { cause: err },
    )
  }
}

function cmdUp(rest: string[]): void {
  const res = drillUp(parseUp(rest))
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
  // own-key lookup — an inherited key like `toString` is not a subcommand
  const known = Object.hasOwn(KNOWN_FLAGS, sub) ? KNOWN_FLAGS[sub] : undefined
  if (!known) {
    return
  }
  for (const arg of argv) {
    // single-dash typos too — `-p 3` silently becoming a title is worse
    // than an error (no drill flag uses one dash; bare "-" stays a title)
    if (arg.length > 1 && arg.startsWith('-') && !known.has(arg)) {
      console.error(`error: unknown option "${arg}" for drill ${sub}`)
      process.exit(2)
    }
  }
}

export async function runDrillCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  // zero-arg magic: bare `bro drill` shows where the descent stands
  if (!sub) {
    checkBeads()
    cmdCurrent()
    return
  }
  if (sub === '--help' || sub === '-h') {
    usage(0)
  }
  // Validate before checkBeads — `bro drill bogus` must report a syntax
  // error even where beads isn't initialized.
  if (!Object.hasOwn(KNOWN_FLAGS, sub)) {
    usage()
  }
  rejectUnknownFlags(sub, rest)
  // these subs take no positional args — a stray one is a typo, not input
  const noPositionals = new Set(['up', 'current', 'tree', 'list'])
  const extras = drillPositionals(rest)
  if (noPositionals.has(sub) && extras.length > 0) {
    console.error(`error: unexpected argument "${extras[0]}"`)
    process.exit(2)
  }
  // command-specific operands/flag values too — all syntax errors must
  // surface before checkBeads() can mask them with a setup error
  if (sub === 'down') {
    parseDown(rest)
  } else if (sub === 'up') {
    parseUp(rest)
  } else if (sub === 'distill') {
    parseDistill(rest)
  }
  checkBeads()

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
      process.stdout.write(bd(['mol', 'distill', parseDistill(rest)]))
      return
    }
    default:
      usage()
  }
}
