/**
 * `bro guard <verb>` — the guard facade (spec: specs/sessions/bro-nkn6.md).
 * Guards are declarative prompt contributions — this milestone ships the
 * declaration surface: schema, config `defs`, connector collection,
 * and `list`. Evaluation (`test`, hook emit paths) lands with the
 * engine in bro-nkn6.3.
 *
 *   list [--json]   every resolved guard: name, source, on-events,
 *                   budget, validation state — TSV like spec drift
 */
import { collectGuards, type CollectedGuard, GUARD_DEFAULT_BUDGET } from '@broject/core'
import { positionals } from './args.ts'
import { loadBroConfig } from '../plugins.ts'

const VALUE_FLAGS = new Set<string>([])

function fail(msg: string, code = 2): never {
  console.error(`error: ${msg}`)
  process.exit(code)
}

/** Boolean flags accept the bare and `=true|false` spellings — anything
 *  else fails closed rather than silently writing on a typo'd value. */
function boolFlag(argv: string[], name: string): boolean {
  const occurrences = argv.filter((a) => a === name || a.startsWith(`${name}=`))
  if (occurrences.length > 1) {
    fail(`${name} may be given only once`)
  }
  const arg = occurrences[0]
  if (arg === undefined) return false
  if (arg === name) return true
  const v = arg.slice(name.length + 1)
  if (v !== 'true' && v !== 'false') {
    fail(`${name} must be true|false — got "${v}"`)
  }
  return v === 'true'
}

interface GuardRow {
  name: string
  source: string
  on: string
  budget: number | '-'
  state: string
}

function toRow(c: CollectedGuard): GuardRow {
  if (c.guard !== undefined) {
    return {
      name: c.guard.name,
      source: c.source,
      on: c.guard.when.on.join(','),
      budget: c.guard.when.budget ?? GUARD_DEFAULT_BUDGET,
      state: 'ok',
    }
  }
  return {
    name: c.name ?? '-',
    source: c.source,
    on: '-',
    budget: '-',
    state: `skipped: ${(c.problems ?? []).join('; ')}`,
  }
}

function cmdList(argv: string[]): void {
  if (positionals(argv, VALUE_FLAGS).length > 0) {
    fail('usage: bro guard list [--json]')
  }
  const json = boolFlag(argv, '--json')
  const cwd = process.cwd()
  const config = loadBroConfig(cwd)
  const guard = config.guard as { defs?: unknown[] } | undefined
  const defs = Array.isArray(guard?.defs) ? guard.defs : []
  const rows = collectGuards({ dir: cwd }, defs as never[]).map(toRow)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  for (const r of rows) {
    console.log(`${r.name}\t${r.source}\t${r.on}\t${r.budget}\t${r.state}`)
  }
}

export function runGuardCommand(argv: string[]): void {
  const sub = argv[0]
  const rest = argv.slice(1)
  switch (sub) {
    case 'list':
      cmdList(rest)
      return
    default:
      console.error(`Usage: bro guard <command> [args…]

Commands:
  list     Every resolved guard — name, source, on-events, budget,
           validation state [--json]

test/evaluation lands with the guard engine (bro-nkn6.3).`)
      process.exit(sub === undefined ? 1 : 2)
  }
}
