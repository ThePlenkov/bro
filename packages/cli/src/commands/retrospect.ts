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
import {
  captureWtf,
  checkBeads,
  listRetros,
  openPreventions,
  openWtf,
  parsePlan,
  PLAN_SCHEMA,
  recordRetro,
} from '@bro/retro'
import type { RetroPlan } from '@bro/retro'
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
  const plan = parsePlan(text, file)
  return wtfFlag ? { ...plan, wtf: wtfFlag } : plan
}

function cmdRecord(plan: RetroPlan): void {
  const res = recordRetro(plan)
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

export async function runRetrospectCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub) {
    usage()
  }
  if (sub === '--help' || sub === '-h') {
    usage(0)
  }
  // own-key lookup — an inherited key like `toString` is not a subcommand
  const known = Object.hasOwn(KNOWN_FLAGS, sub) ? KNOWN_FLAGS[sub] : undefined
  if (!known) {
    usage()
  }
  // capture args are verbatim complaint text — no flag validation
  if (sub !== 'capture') {
    for (const arg of rest) {
      if (arg.startsWith('--') && !known.has(arg)) {
        console.error(`error: unknown option "${arg}" for retrospect ${sub}`)
        process.exit(2)
      }
    }
  }
  // --help/-h must work without a beads checkout. For capture only a
  // leading help token counts — a `--help` inside the complaint is text.
  const wantsHelp =
    sub === 'capture'
      ? rest[0] === '--help' || rest[0] === '-h'
      : rest.includes('--help') || rest.includes('-h')
  if (wantsHelp) {
    usage(0)
  }
  // input validation before checkBeads — a bad plan file or missing
  // complaint must report itself, not a beads setup error
  const plan = sub === 'record' ? readPlan(rest) : undefined
  if (sub !== 'schema') {
    checkBeads()
  }
  // these subs take no positional args — a stray one is a typo, not input
  const pos = retroPositionals(rest)
  if ((sub === 'status' || sub === 'list' || sub === 'schema') && pos.length > 0) {
    console.error(`error: unexpected argument "${pos[0] ?? ''}"`)
    process.exit(2)
  }

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
