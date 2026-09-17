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

/** A value flag's argument must exist and not look like another option. */
function flagValue(argv: string[], i: number, name: string): string {
  const v = argv[i + 1]
  if (v === undefined || v.trim() === '' || v.startsWith('--')) {
    console.error(`error: ${name} requires a value`)
    process.exit(2)
  }
  return v
}

/** Scalar flags are not repeatable — a second occurrence can hide a
 * missing value (`--result ok --result`) that would pass validation. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) {
    return undefined
  }
  if (argv.indexOf(name, i + 1) >= 0) {
    console.error(`error: ${name} may be given only once`)
    process.exit(2)
  }
  return flagValue(argv, i, name)
}

function flagAll(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      out.push(flagValue(argv, i, name))
      i += 1
    }
  }
  return out
}

function positionals(argv: string[]): string[] {
  const valueFlags = new Set([
    '--under',
    '--result',
    '--prevent',
    '--evidence',
    '--type',
    '--priority',
    '--description',
    '--id',
  ])
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg)) {
        i += 1
      }
      continue
    }
    out.push(arg)
  }
  return out
}

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
  const title = positionals(rest).join(' ')
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
  const ids = positionals(rest)
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
  const known = KNOWN_FLAGS[sub]
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
  if (!sub) {
    usage()
  }
  if (sub === '--help' || sub === '-h') {
    usage(0)
  }
  // Validate before checkBeads — `bro drill bogus` must report a syntax
  // error even where beads isn't initialized.
  if (!KNOWN_FLAGS[sub]) {
    usage()
  }
  rejectUnknownFlags(sub, rest)
  // these subs take no positional args — a stray one is a typo, not input
  const noPositionals = new Set(['up', 'current', 'tree', 'list'])
  const extras = positionals(rest)
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
