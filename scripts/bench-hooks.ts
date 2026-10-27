/**
 * bench-hooks — hook-event latency baseline (spec: specs/bro-qbnre.md).
 *
 * Spawns each session-lifecycle hook event N times in a fresh process
 * against a quiet bro-enabled fixture and reports min/p50/p95/max per
 * row as JSON. Three rows per event:
 *
 *   runsh:<event>   sh hooks/run.sh — the process plugin hosts exec
 *   dist:<event>    node packages/cli/dist/index.js — dispatch minus
 *                   the launcher, so run.sh's share is visible
 *   noop:<event>    BRO_HOOKS=0 sh hooks/run.sh — the machine-backend
 *                   skip; a spawned-agent tree pays ~nothing (bro-ddksm)
 *
 * "Quiet" = a scratch repo with bro.config.json + a `.beads/` store
 * served by the e2e fake bd/docker: healthy and empty — a real bd's
 * dolt handshake is a property of the store, not of bro's dispatch.
 * The env is scrubbed (ambient GH_TOKEN/BRO_/XDG dropped, HOME +
 * XDG_* pinned into the fixture, BRO_TELEMETRY=0) so operator config,
 * mailbox state and the OTLP plane can't leak into the number.
 * BRO_HOOKS_NO_FALLBACK=1 pins run.sh to the in-tree dist — a failed
 * dispatch is the measurement, never a silent PATH-bro swap — and a
 * hook that fails open is caught via the HOOK_DISPATCH_ERR marker it
 * writes to stderr (exit stays 0 by contract).
 *
 *   node scripts/bench-hooks.ts                 # table
 *   node scripts/bench-hooks.ts --json          # JSON on stdout
 *   node scripts/bench-hooks.ts --out hooks-latency.json --enforce
 *   node scripts/bench-hooks.ts --runs 50 --warmup 3
 *   node scripts/bench-hooks.ts --budget budgets.json --enforce
 *
 * --enforce compares each budgeted row's p50 against the committed
 * budget below AND fails when any measured row has errors — a broken
 * hook is a failure whether or not it carries a latency budget. Rows
 * without a budget are recorded, not gated on latency (children of
 * bro-5tpx0 add theirs when they land).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  e2eEnv,
  initRepo,
  installFakeBd,
} from '../packages/cli/src/commands/testrepo.ts'
import { HOOK_DISPATCH_ERR } from '../packages/cli/src/commands/hook-signal.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_DIST = join(ROOT, 'packages', 'cli', 'dist', 'index.js')
const RUN_SH = join(ROOT, 'hooks', 'run.sh')

/** Session-lifecycle events only — git-hook entries (prepare-commit-msg
 *  et al.) are a different contract and never on the per-tool-call
 *  path. Each payload is the minimal valid devin/claude hook JSON. */
const EVENTS: { event: string; payload: (sid: string) => unknown }[] = [
  { event: 'session-start', payload: (sid) => ({ session_id: sid }) },
  { event: 'post-compaction', payload: (sid) => ({ session_id: sid }) },
  { event: 'pre-compact', payload: (sid) => ({ session_id: sid }) },
  {
    event: 'prompt-submit',
    payload: (sid) => ({ session_id: sid, prompt: 'bench prompt' }),
  },
  {
    event: 'pre-tool',
    payload: (sid) => ({
      session_id: sid,
      tool_name: 'exec',
      tool_input: { command: 'ls' },
    }),
  },
  {
    event: 'post-tool',
    payload: (sid) => ({
      session_id: sid,
      tool_name: 'read',
      tool_input: { file_path: 'x' },
      tool_response: { success: true },
    }),
  },
  { event: 'stop', payload: (sid) => ({ session_id: sid }) },
  {
    event: 'permission',
    payload: (sid) => ({
      session_id: sid,
      tool_name: 'exec',
      tool_input: { command: 'ls' },
    }),
  },
]

/** p50 budgets in ms (bead bro-qbnre's initial numbers; E2/E3 tighten
 *  and extend). Keys are `<lane>:<event>` — rows not listed are
 *  recorded, not latency-gated. */
const BUDGET_P50_MS: Record<string, number> = {
  'noop:post-tool': 150,
  'noop:prompt-submit': 150,
  'runsh:session-start': 600,
  'runsh:stop': 600,
}

const LANES = ['runsh', 'dist', 'noop'] as const
type Lane = (typeof LANES)[number]

interface Row {
  n: number
  min: number
  p50: number
  p95: number
  max: number
  errors: number
}

interface Options {
  runs: number
  warmup: number
  out: string | undefined
  budgetFile: string | undefined
  enforce: boolean
  asJson: boolean
  lanes: Lane[]
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function parseArgs(argv: string[]): Options {
  const runs = Number(argValue(argv, '--runs') ?? 20)
  const warmup = Number(argValue(argv, '--warmup') ?? 1)
  const rawLanes = argValue(argv, '--lanes')?.split(',') ?? [...LANES]
  if (!Number.isFinite(runs) || runs < 3 || !Number.isFinite(warmup) || warmup < 0) {
    console.error('bench-hooks: need --runs ≥3 and --warmup ≥0')
    process.exit(2)
  }
  const bad = rawLanes.filter((l) => !(LANES as readonly string[]).includes(l))
  if (bad.length > 0) {
    console.error(
      `bench-hooks: unknown --lanes ${bad.join(',')} — expected a comma-list of ${LANES.join(', ')}`
    )
    process.exit(2)
  }
  return {
    runs,
    warmup,
    out: argValue(argv, '--out'),
    budgetFile: argValue(argv, '--budget'),
    enforce: argv.includes('--enforce'),
    asJson: argv.includes('--json'),
    lanes: rawLanes as Lane[],
  }
}

function loadBudget(file: string | undefined): Record<string, number> {
  if (file === undefined) {
    return BUDGET_P50_MS
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
    return { ...BUDGET_P50_MS, ...parsed }
  } catch (e) {
    console.error(
      `bench-hooks: cannot read --budget ${file} — ${e instanceof Error ? e.message : String(e)}`
    )
    process.exit(2)
  }
}

/** Quiet fixture: opted-in repo, healthy-empty beads store, scrubbed
 *  env. BRO_HOOKS_NO_FALLBACK pins run.sh to the in-tree dist so a
 *  broken build can never hide behind a PATH-bro or npx fallback. */
function buildFixture(): { cwd: string; env: NodeJS.ProcessEnv } {
  const { root, main } = initRepo('bro-bench-hooks-', (m) => {
    writeFileSync(join(m, 'bro.config.json'), '{}\n')
    mkdirSync(join(m, '.beads'), { recursive: true })
    writeFileSync(join(m, '.beads', 'beads.json'), '{"rows":[]}\n')
    mkdirSync(join(m, 'home'), { recursive: true })
  })
  const { binDir, db } = installFakeBd(root, [])
  const env = e2eEnv({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
    HOME: join(main, 'home'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    BRO_TELEMETRY: '0',
    BRO_HOOKS_NO_FALLBACK: '1',
  })
  return { cwd: main, env }
}

interface Attempt {
  ms: number
  ok: boolean
  detail: string
  /** spawn error or the 30s kill — retrying re-pays the same hang. */
  fatal: boolean
}

/** One spawn — wall clock is the metric (process spawn + boot +
 *  dispatch is what the host pays). A run is an error on non-zero
 *  exit, a spawn error/timeout, or the HOOK_DISPATCH_ERR marker — the
 *  hook's fail-open contract keeps exit 0 on a dispatch throw, so the
 *  stderr line is the only signal a watchdog can count. */
function attempt(
  lane: Lane,
  event: string,
  input: string | undefined,
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Attempt {
  const [command, args]: [string, string[]] =
    lane === 'dist'
      ? [process.execPath, [CLI_DIST, 'hooks', event]]
      : ['sh', [RUN_SH, event]]
  const t0 = performance.now()
  const proc = spawnSync(command, args, {
    cwd: opts.cwd,
    input,
    env: opts.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const ms = performance.now() - t0
  const stderr = typeof proc.stderr === 'string' ? proc.stderr : ''
  const ok =
    proc.status === 0 && proc.error === undefined && !stderr.includes(HOOK_DISPATCH_ERR)
  const detail = `status=${proc.status} signal=${proc.signal} err=${proc.error?.message ?? ''} stderr=${stderr.slice(0, 300)}`
  return { ms, ok, detail, fatal: proc.error !== undefined }
}

/** stdin for one attempt — a fresh session id per run, since the trace
 *  journal and skill-hinted markers are per-session; reusing one id
 *  lets later runs measure a different session's accumulated state.
 *  noop skips stdin: with BRO_HOOKS=0 run.sh exits before reading it
 *  for every event but permission, so writing the payload would race
 *  the exit (EPIPE). */
function rowInput(
  lane: Lane,
  event: string,
  payload: (sid: string) => unknown,
  i: number
): string | undefined {
  return lane === 'noop' && event !== 'permission'
    ? undefined
    : JSON.stringify(payload(`${lane}-${event}-${i}`))
}

/** Measured-error accounting — the first failure's detail is the only
 *  one logged; N copies of the same break are noise. */
function countSampleError(row: string, i: number, a: Attempt, prior: number): number {
  if (a.ok) {
    return 0
  }
  if (prior === 0) {
    console.error(`bench-hooks: ${row} run ${i} failed — ${a.detail}`)
  }
  return 1
}

/** A row's `errors` counts measured runs only — warmup failures are
 *  logged but never gated: a discarded sample must not decide CI. */
function benchRow(
  lane: Lane,
  event: string,
  payload: (sid: string) => unknown,
  opts: { cwd: string; env: NodeJS.ProcessEnv; runs: number; warmup: number }
): Row {
  const times: number[] = []
  let errors = 0
  for (let i = 0; i < opts.warmup + opts.runs; i++) {
    const a = attempt(lane, event, rowInput(lane, event, payload, i), opts)
    if (a.fatal) {
      // spawn failure or the 30s timeout — the remaining attempts
      // re-pay the same hang (24 rows × 21 × 30s tops ~4h on a dead
      // hook). Count once — even in warmup, an empty row must not
      // read as clean — and stop sampling.
      errors++
      console.error(`bench-hooks: ${lane}:${event} aborting — ${a.detail}`)
      break
    }
    if (i < opts.warmup) {
      if (!a.ok) {
        console.error(`bench-hooks: ${lane}:${event} warmup failed — ${a.detail}`)
      }
      continue
    }
    times.push(a.ms)
    errors += countSampleError(`${lane}:${event}`, i, a, errors)
  }
  times.sort((a, b) => a - b)
  return {
    n: times.length,
    min: Math.round(times[0] ?? 0),
    p50: Math.round(percentile(times, 0.5)),
    p95: Math.round(percentile(times, 0.95)),
    max: Math.round(times.at(-1) ?? 0),
    errors,
  }
}

function runBench(opts: Options, cwd: string, env: NodeJS.ProcessEnv): Map<string, Row> {
  const rows = new Map<string, Row>()
  for (const lane of opts.lanes) {
    const laneEnv = lane === 'noop' ? { ...env, BRO_HOOKS: '0' } : env
    for (const { event, payload } of EVENTS) {
      rows.set(
        `${lane}:${event}`,
        benchRow(lane, event, payload, {
          cwd,
          env: laneEnv,
          runs: opts.runs,
          warmup: opts.warmup,
        })
      )
    }
  }
  return rows
}

function printTable(rows: Map<string, Row>): void {
  console.log('row                                 n    min    p50    p95    max  errors')
  for (const [k, r] of rows) {
    console.log(
      `${k.padEnd(34)} ${String(r.n).padStart(3)} ${String(r.min).padStart(6)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.errors).padStart(6)}`
    )
  }
}

/** stdout carries the table, or the JSON report in --json mode — never
 *  both, so `--json` output always parses. --out writes the file in
 *  either mode. */
function writeReport(
  rows: Map<string, Row>,
  budget: Record<string, number>,
  opts: Options
): void {
  let sha = ''
  try {
    sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim()
  } catch {
    // reporting metadata only
  }
  const report = {
    meta: {
      ts: new Date().toISOString(),
      sha,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      runs: opts.runs,
      warmup: opts.warmup,
      fixture: 'quiet (bro.config.json + empty fake-bd store)',
    },
    rows: Object.fromEntries(rows),
    budget,
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (opts.out !== undefined) {
    writeFileSync(opts.out, json)
  }
  if (opts.asJson) {
    process.stdout.write(json)
  } else {
    printTable(rows)
  }
}

/** The CI ratchet: budgeted rows must hold p50 with zero errors, and
 *  ANY measured row with errors fails — a broken hook is a failure
 *  whether or not it carries a latency budget. Verdicts go to stderr
 *  under --json so stdout stays parseable. Returns true on failure. */
function enforce(
  rows: Map<string, Row>,
  budget: Record<string, number>,
  asJson: boolean
): boolean {
  const say = (line: string): void => {
    if (asJson) {
      console.error(line)
    } else {
      console.log(line)
    }
  }
  let failed = false
  for (const [key, cap] of Object.entries(budget)) {
    const r = rows.get(key)
    if (r === undefined) {
      say(`budget ${key}: no row measured`)
      failed = true
      continue
    }
    const verdict = r.p50 <= cap && r.errors === 0 ? 'ok' : 'OVER'
    if (verdict === 'OVER') {
      failed = true
    }
    say(`${verdict.padEnd(4)} ${key} p50=${r.p50}ms budget=${cap}ms errors=${r.errors}`)
  }
  for (const [key, r] of rows) {
    if (r.errors > 0 && !(key in budget)) {
      say(`ERR  ${key} errors=${r.errors} — unbudgeted row with failures`)
      failed = true
    }
  }
  return failed
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(CLI_DIST)) {
    console.error('bench-hooks: packages/cli/dist is missing — run `npm run build` first')
    process.exit(2)
  }
  const budget = loadBudget(opts.budgetFile)
  const { cwd, env } = buildFixture()
  const rows = runBench(opts, cwd, env)
  writeReport(rows, budget, opts)
  if (opts.enforce && enforce(rows, budget, opts.asJson)) {
    process.exit(1)
  }
}

main()
