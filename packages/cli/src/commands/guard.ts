/**
 * `bro guard <verb>` — the guard facade (spec: specs/sessions/bro-nkn6.md).
 * Guards are declarative prompt contributions: schema + config `defs` +
 * connector collection (`list`), and the engine read path (`test`).
 * Judge-veto clauses land in bro-nkn6.4.
 *
 *   list [--json]                          every resolved guard — TSV
 *   test <name> [--event E] [--prompt T]   per-clause verdicts, then
 *                                          FIRE|SKIP + the rendered line;
 *                                          never touches the fired set
 */
import {
  collectGuards,
  GUARD_DEFAULT_BUDGET,
  isGuardEvent,
  type CollectedGuard,
  type GuardEvent,
} from '@broject/core'
import {
  hooksDir,
  readTraceTail,
  relativize,
  resolveSessionId,
  traceFile,
} from '@broject/learn'
import { runGuards, type GuardConfig, type GuardJudgeInput } from '@broject/guard'
import { judgeConfig, judgeFacade } from '@broject/judge'
import { flag, positionals } from './args.ts'
import { readArmed } from './hooks.ts'
import { loadBroConfig } from '../plugins.ts'

const VALUE_FLAGS = new Set<string>(['--event', '--prompt', '--session'])

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
  const cfg = guardCfg(cwd)
  const rows = collectGuards({ dir: cwd }, cfg.defs).map(toRow)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  for (const r of rows) {
    console.log(`${r.name}\t${r.source}\t${r.on}\t${r.budget}\t${r.state}`)
  }
}

function guardCfg(dir: string): GuardConfig {
  return (loadBroConfig(dir) as Record<string, unknown>).guard as GuardConfig
}

/** Evaluate one guard against the live dir + this session. Read-only:
 *  `record` stays false, so the fired set and the verdict journal are
 *  never touched. Exit 0 = FIRE, 1 = SKIP, 2 = usage. */
async function cmdTest(argv: string[]): Promise<void> {
  const pos = positionals(argv, VALUE_FLAGS)
  if (pos.length !== 1) {
    fail('usage: bro guard test <name> [--event E] [--prompt T] [--session ID]')
  }
  const name = pos[0]!
  const cwd = process.cwd()
  const cfg = guardCfg(cwd)
  const collected = collectGuards({ dir: cwd }, cfg.defs)
  const hit = collected.find((c) => (c.guard?.name ?? c.name) === name)
  if (hit === undefined || hit.guard === undefined) {
    fail(`no guard '${name}' — bro guard list shows the resolved set`, 1)
  }
  const g = hit.guard
  const eventArg = flag(argv, '--event')
  if (eventArg !== undefined && !isGuardEvent(eventArg)) {
    fail(`--event must be a hook event — got "${eventArg}"`)
  }
  const event: GuardEvent = eventArg ?? g.when.on[0]!
  const prompt = flag(argv, '--prompt')
  const sessionId = resolveSessionId(cwd, flag(argv, '--session'))
  const run = await runGuards({
    dir: cwd,
    sessionId,
    event,
    defs: cfg.defs,
    cfg,
    record: false,
    armed: () => readArmed(sessionId),
    // a live decide() when the clause exists — test is the honest read
    // of what the hook would do; no journal sink keeps it a read
    judge: () => {
      const jcfg = judgeConfig(cwd).judge
      if (jcfg.mode !== 'shadow') {
        return undefined
      }
      const input: GuardJudgeInput = {
        facade: judgeFacade(cwd),
        confidence: jcfg.confidence,
        maxDecisions: jcfg.maxDecisionsPerRun,
      }
      return input
    },
    mctx: async () => {
      const hooks = hooksDir(cwd)
      const tail = hooks === null ? { entries: [], raw: '' } : readTraceTail(traceFile(hooks, sessionId))
      return { text: prompt ?? tail.raw, trace: relativize(cwd, tail.entries) }
    },
  })
  const v = run.verdicts.find((x) => x.name === name)
  if (v === undefined) {
    fail(`guard '${name}' did not resolve`, 1)
  }
  console.log(`guard ${v.name}\t${v.source}\tevent=${event}\tsession=${sessionId}`)
  for (const c of v.clauses) {
    console.log(`  ${c.clause}\t${c.ok ? 'ok' : 'miss'}${c.detail === undefined ? '' : `\t${c.detail}`}`)
  }
  if (v.fire) {
    console.log(`FIRE\n${v.line}`)
    process.exit(0)
  }
  console.log('SKIP')
  process.exit(1)
}

export function runGuardCommand(argv: string[]): void | Promise<void> {
  const sub = argv[0]
  const rest = argv.slice(1)
  if (sub === 'list') {
    cmdList(rest)
    return
  }
  if (sub === 'test') {
    return cmdTest(rest)
  }
  console.error(`Usage: bro guard <command> [args…]

Commands:
  list     Every resolved guard — name, source, on-events, budget,
           validation state [--json]
  test     Per-clause verdicts then FIRE|SKIP — a read on the engine:
           bro guard test <name> [--event E] [--prompt T] [--session ID]
           exit 0 = FIRE, 1 = SKIP, 2 = usage`)
  process.exit(sub === undefined ? 1 : 2)
}
