/**
 * `bro retrospect <sub>` — self-correction over beads. `wtf` beads capture
 * the user's frustration verbatim; `record` turns a TOML retrospection
 * plan into a closed `retro` bead plus open `prevention` beads the
 * executor routes by `sink:` label. `status` is the exit gate.
 *
 *   capture <complaint…>         open a wtf bead (bro wtf … is an alias)
 *   record <plan.toml>           validate the plan, create retro + actions
 *   status [--json]              gate: exit 1 while a wtf stays unanswered
 *   list                         retro beads + open wtf beads
 *   schema                       print the commented plan template
 */
import { readFileSync } from 'node:fs'
import { facade, loadConfig } from '@broject/core'
import {
  captureWtf,
  checkBeads,
  listRetros,
  openPreventions,
  openWtf,
  parsePlan,
  PLAN_SCHEMA,
  recordRetro,
} from '@broject/retro'
import type { RetroPlan } from '@broject/retro'
import { flag, positionals } from './args.ts'

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--wtf'])

const retroPositionals = (argv: string[]): string[] => positionals(argv, VALUE_FLAGS)

function usage(exitCode = 1): never {
  console.error(`Usage: bro retrospect <command> [args…]

Commands:
  capture <complaint…>   Open a wtf bead — the user's complaint verbatim + context
  record <plan.toml>     Store the retro bead + fan actions out to prevention beads
  status [--json]        Exit gate — open wtf beads block (exit 1)
  list                   Retro beads and open wtf beads
  schema                 Print the commented plan template

  bro wtf <complaint…>   alias for \`bro retrospect capture\``)
  process.exit(exitCode)
}

/** A captured complaint or a recorded retro is a human moment —
 *  publish through the events facade so `notify.sinks` hear it (spec:
 *  specs/bro-huy5o.8.md). Fire-and-forget like `bro notify`: the
 *  pending delivery holds the event loop until it settles; a sink
 *  failure must never turn a capture into a command failure. */
function publishRetroEvent(topic: string, kind: string, key: string, text: string): void {
  const dir = process.cwd()
  // try/catch on the sync half too — `facade` throws on a misconfigured
  // connector name before `.catch` can exist, and the record is already
  // persisted; event delivery stays fail-open after persistence
  try {
    void facade('events', { dir }, { prefer: loadConfig(dir).connectors })
      .publish({ topic, kind, key, source: 'retrospect', payload: text })
      .catch(() => {})
  } catch {
    // fail-open — a bad events config must not fail the capture
  }
}

function cmdCapture(rest: string[]): void {
  // the complaint is verbatim user text — every arg is literal, including
  // `--`-prefixed tokens; only a leading -h/--help asks for usage
  if (rest[0] === '-h' || rest[0] === '--help') {
    usage()
  }
  const complaint = rest.join(' ')
  if (!complaint.trim()) {
    console.error('error: wtf capture requires the complaint — quote the user verbatim')
    process.exit(2)
  }
  const row = captureWtf(complaint)
  publishRetroEvent('wtf', 'note', `wtf-${row.id}`, `wtf ${row.id} captured — ${row.title}`)
  console.log(`wtf ${row.id} captured — now analyze, plan, and \`bro retrospect record\``)
}

/** Read + validate the plan file — pure input checks, no beads needed. */
function readPlan(rest: string[]): RetroPlan {
  const files = retroPositionals(rest)
  const wtfFlag = flag(rest, '--wtf')
  if (files.length !== 1) {
    console.error('error: retrospect record requires exactly one plan file')
    process.exit(2)
  }
  const file = files[0] ?? ''
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    console.error(
      `error: cannot read ${file} — ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(2)
  }
  let plan: RetroPlan
  try {
    plan = parsePlan(text, file)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
  return wtfFlag ? { ...plan, wtf: wtfFlag } : plan
}

/** `retrospect record`'s executor — also the plugin's runPlan for
 * `bro run` (kind = "retrospect"). */
export function cmdRecord(plan: RetroPlan): void {
  // recurrence escalation is a mechanical bar, not a prose one: a retro
  // whose actions are all memory/agentic-documents sinks adds only more
  // prose — warn when no workaround/backlog (i.e. buildable) action exists
  if (!plan.actions.some((a) => a.sink === 'workaround' || a.sink === 'backlog')) {
    console.error(
      'retro: note — no mechanical action (workaround/backlog); a recurring cause survives on prose alone'
    )
  }
  const res = recordRetro(plan)
  publishRetroEvent('retro', 'result', `retro-${res.retroId}`, `retro ${res.retroId} recorded`)
  console.log(`retro ${res.retroId} recorded`)
  for (const id of res.actionIds) {
    console.log(`  prevention → ${id}`)
  }
  if (res.closedWtf) {
    console.log(`  wtf ${res.closedWtf} answered`)
  }
}

function cmdStatus(rest: string[]): void {
  const open = openWtf()
  const preventionCount = openPreventions().length
  if (rest.includes('--json')) {
    console.log(JSON.stringify({ open_wtf: open, open_preventions: preventionCount }))
  } else if (open.length > 0) {
    for (const row of open) {
      console.log(`${row.id}\t${row.title}`)
    }
    console.log(`${open.length} unanswered wtf — record a retro plan to clear`)
  } else {
    console.log(
      `no unanswered wtf${preventionCount > 0 ? ' · ' + preventionCount + ' open prevention' : ''}`
    )
  }
  if (open.length > 0) {
    process.exitCode = 1
  }
}

function cmdList(): void {
  const open = openWtf()
  const retros = listRetros()
  if (open.length === 0 && retros.length === 0) {
    console.log('no retrospection beads')
    return
  }
  for (const row of open) {
    console.log(`${row.id}\topen\t${row.title}`)
  }
  for (const row of retros) {
    console.log(`${row.id}\t${row.status}\t${row.title}`)
  }
}

/** A misspelled option must fail loudly, not dissolve into a title. */
const KNOWN_FLAGS: Record<string, Set<string>> = {
  capture: new Set(),
  record: new Set(['--wtf']),
  status: new Set(['--json']),
  list: new Set(),
  schema: new Set(),
}

/** Reject a misspelled option — capture args are verbatim complaint
 * text, so they skip flag validation entirely. */
function rejectUnknownFlags(sub: string, known: Set<string>, rest: string[]): void {
  if (sub === 'capture') {
    return
  }
  for (const arg of rest) {
    if (arg.startsWith('--') && !known.has(arg)) {
      console.error(`error: unknown option "${arg}" for retrospect ${sub}`)
      process.exit(2)
    }
  }
}

/** --help/-h must work without a beads checkout. For capture only a
 * leading help token counts — a `--help` inside the complaint is text. */
function wantsHelp(sub: string, rest: string[]): boolean {
  return sub === 'capture'
    ? rest[0] === '--help' || rest[0] === '-h'
    : rest.includes('--help') || rest.includes('-h')
}

/** These subs take no positional args — a stray one is a typo, not input. */
function rejectPositionals(sub: string, rest: string[]): void {
  if (sub !== 'status' && sub !== 'list' && sub !== 'schema') {
    return
  }
  const pos = retroPositionals(rest)
  if (pos.length > 0) {
    console.error(`error: unexpected argument "${pos[0] ?? ''}"`)
    process.exit(2)
  }
}

export async function runRetrospectCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  // zero-arg magic: bare `bro retrospect` reports open wtfs
  if (!sub) {
    checkBeads()
    cmdStatus([])
    return
  }
  if (sub === '--help' || sub === '-h') {
    usage(0)
  }
  // own-key lookup — an inherited key like `toString` is not a subcommand
  const known = Object.hasOwn(KNOWN_FLAGS, sub) ? KNOWN_FLAGS[sub] : undefined
  if (!known) {
    usage()
  }
  // help short-circuits flag validation — `bro retrospect status --help`
  // must print usage, not "unknown option"
  if (wantsHelp(sub, rest)) {
    usage(0)
  }
  rejectUnknownFlags(sub, known, rest)
  // input validation before checkBeads — a bad plan file or missing
  // complaint must report itself, not a beads setup error
  const plan = sub === 'record' ? readPlan(rest) : undefined
  if (sub !== 'schema') {
    checkBeads()
  }
  rejectPositionals(sub, rest)

  switch (sub) {
    case 'capture':
      cmdCapture(rest)
      return
    case 'record':
      cmdRecord(plan as RetroPlan)
      return
    case 'status':
      cmdStatus(rest)
      return
    case 'list':
      cmdList()
      return
    case 'schema':
      process.stdout.write(PLAN_SCHEMA)
      return
    default:
      usage()
  }
}
