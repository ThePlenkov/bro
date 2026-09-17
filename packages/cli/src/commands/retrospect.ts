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

function usage(): never {
  console.error(`Usage: bro retrospect <command> [args…]

Commands:
  capture <complaint…>   Open a wtf bead — the user's complaint verbatim + context
  record <plan.toml>     Store the retro bead + fan actions out to prevention beads
  status [--json]        Exit gate — open wtf beads block (exit 1)
  list                   Retro beads and open wtf beads
  schema                 Print the commented plan template

  bro wtf <complaint…>   alias for \`bro retrospect capture\``)
  process.exit(1)
}

/** Scalar flags are not repeatable — a second occurrence can hide a
 * missing value that would pass validation. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) {
    return undefined
  }
  if (argv.indexOf(name, i + 1) >= 0) {
    console.error(`error: ${name} may be given only once`)
    process.exit(2)
  }
  const v = argv[i + 1]
  if (v === undefined || v.trim() === '' || v.startsWith('--')) {
    console.error(`error: ${name} requires a value`)
    process.exit(2)
  }
  return v
}

function positionals(argv: string[]): string[] {
  const valueFlags = new Set(['--wtf'])
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

function cmdCapture(rest: string[]): void {
  const complaint = positionals(rest).join(' ')
  if (!complaint.trim()) {
    console.error('error: wtf capture requires the complaint — quote the user verbatim')
    process.exit(2)
  }
  const row = captureWtf(complaint)
  console.log(`wtf ${row.id} captured — now analyze, plan, and \`bro retrospect record\``)
}

function cmdRecord(rest: string[]): void {
  const files = positionals(rest)
  if (files.length !== 1) {
    console.error('error: retrospect record requires exactly one plan file')
    process.exit(2)
  }
  const file = files[0]!
  const plan = parsePlan(readFileSync(file, 'utf8'), file)
  const wtfFlag = flag(rest, '--wtf')
  if (wtfFlag) {
    plan.wtf = wtfFlag
  }
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
      `no unanswered wtf${preventionCount > 0 ? ` · ${preventionCount} open prevention` : ''}`
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
  if (!sub || sub === '--help' || sub === '-h') {
    usage()
  }
  if (sub === 'schema') {
    process.stdout.write(PLAN_SCHEMA)
    return
  }
  checkBeads()
  const known = KNOWN_FLAGS[sub]
  if (!known) {
    usage()
  }
  for (const arg of rest) {
    if (arg.startsWith('--') && !known.has(arg)) {
      console.error(`error: unknown option "${arg}" for retrospect ${sub}`)
      process.exit(2)
    }
  }
  // these subs take no positional args — a stray one is a typo, not input
  if ((sub === 'status' || sub === 'list') && positionals(rest).length > 0) {
    console.error(`error: unexpected argument "${positionals(rest)[0]}"`)
    process.exit(2)
  }

  switch (sub) {
    case 'capture':
      cmdCapture(rest)
      return
    case 'record':
      cmdRecord(rest)
      return
    case 'status':
      cmdStatus(rest)
      return
    case 'list':
      cmdList()
      return
    default:
      usage()
  }
}
