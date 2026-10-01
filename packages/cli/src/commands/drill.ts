/**
 * `bro drill <sub>` — scoped descent over beads. Frames are issues labeled
 * `drill`; bd owns storage, bro owns the invariants (mandatory result +
 * prevention memo on the way up).
 *
 *   down <title> [--under ID] [--ephemeral]   descend into a narrower frame
 *   up --result T [--prevent T]… [--evidence R]… [--report]   ascend, hand result to parent
 *   current                                   active leaf frame
 *   tree                                      all drill trees
 *   list                                      open frames
 *   report                                    published reports under drill.report.dir
 *   distill ID                                bd mol distill: tree → proto
 */
import { createInterface } from 'node:readline/promises'
import { relative, resolve } from 'node:path'
import { gitTry, loadConfig } from '@broject/core'
import {
  checkBeads,
  currentFrame,
  DEFAULT_DRILL_CONFIG,
  drillDown,
  drillSection,
  drillTree,
  drillUp,
  listDrills,
  listReports,
  bd,
  taskStore,
  type DrillConfig,
  type DrillPlan,
  type DrillRow,
} from '@broject/drill'
import { flag, flagAll, positionals } from './args.ts'

function usage(exitCode = 1): never {
  console.error(`Usage: bro drill <command> [args…]

Commands:
  down <title> [--under ID] [--ephemeral]        New child frame under current leaf (or root)
  up --result T [--prevent T]… [--evidence R]…   Close current frame, memo goes to beads
     [--report]                                  also write drills/<id>.md (drill.report)
  current                                        Show the active leaf frame
  tree                                           Render all drill hierarchies
  list                                           Open drill frames
  report                                         List published drill reports
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
    report: rest.includes('--report'),
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
        taskStore().remove(id)
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

/** `drill.report` section + repo root — the dir resolves against the
 *  worktree root so the report rides the branch like any file. */
function reportConfig(): { dir: string; mode: DrillConfig['report']['mode'] } {
  const cfg = loadConfig(process.cwd(), { drill: drillSection }) as {
    drill?: DrillConfig
  }
  const rep = cfg.drill?.report ?? DEFAULT_DRILL_CONFIG.report
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd()
  return { dir: resolve(root, rep.dir), mode: rep.mode }
}

/** Best-effort frame lookup for the report decision — a miss just means
 *  no prompt; drillUp produces the authoritative error. */
function safeRow(id: string): DrillRow | undefined {
  try {
    return taskStore().get<DrillRow>(id)
  } catch {
    return undefined
  }
}

/** Whether this `drill up` writes a report: explicit --report always does;
 *  mode 'always' covers persistent frames (ephemeral wisps still need the
 *  flag); 'prompt' asks on a TTY and degrades to off without one. */
async function resolveReportDir(args: ReturnType<typeof parseUp>): Promise<string | undefined> {
  const rc = reportConfig()
  if (args.report) {
    return rc.dir
  }
  if (rc.mode === 'off') {
    return undefined
  }
  const target = args.id ? safeRow(args.id) : currentFrame()
  if (!target) {
    return undefined
  }
  if (rc.mode === 'always') {
    return target.ephemeral ? undefined : rc.dir
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `publish drill report → ${relative(process.cwd(), rc.dir) || '.'}/${target.id}.md? [Y/n] `
    )
    const a = answer.trim()
    return a === '' || /^y(es)?$/i.test(a) ? rc.dir : undefined
  } finally {
    rl.close()
  }
}

async function cmdUp(rest: string[]): Promise<void> {
  const args = parseUp(rest)
  const reportDir = await resolveReportDir(args)
  const res = drillUp({ ...args, reportDir })
  console.log(`drill ↑ ${res.closed} closed`)
  for (const id of res.preventionIds) {
    console.log(`  prevention → ${id}`)
  }
  if (res.reportPath) {
    const rel = relative(process.cwd(), res.reportPath)
    console.log(`  report → ${rel.startsWith('..') ? res.reportPath : rel}`)
  }
}

function cmdReport(): void {
  const { dir } = reportConfig()
  const rows = listReports(dir)
  if (rows.length === 0) {
    console.log('no drill reports')
    return
  }
  for (const row of rows) {
    const rel = relative(process.cwd(), row.path)
    console.log(`${row.id}\t${row.title}\t${rel.startsWith('..') ? row.path : rel}`)
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
  up: new Set(['--id', '--result', '--prevent', '--evidence', '--report']),
  current: new Set(),
  tree: new Set(),
  list: new Set(),
  report: new Set(),
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
  const noPositionals = new Set(['up', 'current', 'tree', 'list', 'report'])
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
      await cmdUp(rest)
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
    case 'report':
      cmdReport()
      return
    case 'distill': {
      process.stdout.write(bd(['mol', 'distill', parseDistill(rest)]))
      return
    }
    default:
      usage()
  }
}
