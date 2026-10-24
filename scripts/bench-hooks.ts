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
 *
 *   node scripts/bench-hooks.ts                 # table
 *   node scripts/bench-hooks.ts --json          # JSON on stdout
 *   node scripts/bench-hooks.ts --out hooks-latency.json --enforce
 *   node scripts/bench-hooks.ts --runs 50 --warmup 3
 *   node scripts/bench-hooks.ts --budget budgets.json --enforce
 *
 * --enforce compares each budgeted row's p50 against the committed
 * budget below and exits 1 when any row is over — CI's ratchet. Rows
 * without a budget are recorded, not gated (children of bro-5tpx0 add
 * theirs when they land).
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
 *  recorded, not gated. */
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

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

/** One spawn per run — wall clock is the metric (process spawn + boot
 *  + dispatch is what the host pays). A non-zero exit or timeout still
 *  counts toward the row (and toward `errors`): the fail-open contract
 *  makes exit≠0 a bug worth surfacing, not a sample to drop. */
function benchRow(
  lane: Lane,
  event: string,
  payload: (sid: string) => unknown,
  opts: { cwd: string; env: NodeJS.ProcessEnv; runs: number; warmup: number }
): Row {
  const times: number[] = []
  let errors = 0
  for (let i = 0; i < opts.warmup + opts.runs; i++) {
    const argv =
      lane === 'dist'
        ? [process.execPath, CLI_DIST, 'hooks', event]
        : ['sh', RUN_SH, event]
    const t0 = performance.now()
    // a fresh session id per run — the trace journal and skill-hinted
    // markers are per-session; reusing one id lets later runs measure
    // a different session's accumulated state. noop skips stdin: with
    // BRO_HOOKS=0 run.sh exits before reading it for every event but
    // permission, so writing the payload would race the exit (EPIPE).
    const proc = spawnSync(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      input:
        lane === 'noop' && event !== 'permission'
          ? undefined
          : JSON.stringify(payload(`${lane}-${event}-${i}`)),
      env: opts.env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    const ms = performance.now() - t0
    if (proc.status !== 0 || proc.error !== undefined) {
      errors++
      if (errors === 1) {
        console.error(
          `bench-hooks: ${lane}:${event} run ${i} failed — status=${proc.status} signal=${proc.signal} err=${proc.error?.message ?? ''} stderr=${(proc.stderr ?? '').slice(0, 300)}`
        )
      }
    }
    if (i >= opts.warmup) {
      times.push(ms)
    }
  }
  times.sort((a, b) => a - b)
  return {
    n: times.length,
    min: Math.round(times[0] ?? 0),
    p50: Math.round(percentile(times, 0.5)),
    p95: Math.round(percentile(times, 0.95)),
    max: Math.round(times[times.length - 1] ?? 0),
    errors,
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function main(): void {
  const argv = process.argv.slice(2)
  const runs = Number(argValue(argv, '--runs') ?? 20)
  const warmup = Number(argValue(argv, '--warmup') ?? 1)
  const out = argValue(argv, '--out')
  const budgetFile = argValue(argv, '--budget')
  const enforce = argv.includes('--enforce')
  const asJson = argv.includes('--json')
  const laneFilter = argValue(argv, '--lanes')?.split(',') as Lane[] | undefined
  if (!Number.isFinite(runs) || runs < 3 || !Number.isFinite(warmup) || warmup < 0) {
    console.error('bench-hooks: need --runs ≥3 and --warmup ≥0')
    process.exit(2)
  }
  if (!existsSync(CLI_DIST)) {
    console.error('bench-hooks: packages/cli/dist is missing — run `npm run build` first')
    process.exit(2)
  }
  const budget: Record<string, number> =
    budgetFile === undefined
      ? BUDGET_P50_MS
      : { ...BUDGET_P50_MS, ...(JSON.parse(readFileSync(budgetFile, 'utf8')) as Record<string, number>) }

  // quiet fixture: opted-in repo, healthy-empty beads store, scrubbed env
  const { root, main } = initRepo('bro-bench-hooks-', (m) => {
    writeFileSync(join(m, 'bro.config.json'), '{}\n')
    mkdirSync(join(m, '.beads'), { recursive: true })
    writeFileSync(join(m, '.beads', 'beads.json'), '{"rows":[]}\n')
    mkdirSync(join(m, 'home'), { recursive: true })
  })
  const { binDir, db } = installFakeBd(root, [])
  const baseEnv = e2eEnv({
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_BD_DB: db,
    HOME: join(main, 'home'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    BRO_TELEMETRY: '0',
  })

  const lanes = laneFilter ?? [...LANES]
  const rows: Record<string, Row> = {}
  for (const lane of lanes) {
    for (const { event, payload } of EVENTS) {
      const key = `${lane}:${event}`
      const env =
        lane === 'noop' ? { ...baseEnv, BRO_HOOKS: '0' } : baseEnv
      rows[key] = benchRow(lane, event, payload, {
        cwd: main,
        env,
        runs,
        warmup,
      })
    }
  }

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
      runs,
      warmup,
      fixture: 'quiet (bro.config.json + empty fake-bd store)',
    },
    rows,
    budget,
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (out !== undefined) {
    writeFileSync(out, json)
  }
  if (asJson || out === undefined) {
    process.stdout.write(json)
  }
  if (!asJson) {
    console.log('row                                 n    min    p50    p95    max  errors')
    for (const [k, r] of Object.entries(rows)) {
      console.log(
        `${k.padEnd(34)} ${String(r.n).padStart(3)} ${String(r.min).padStart(6)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.errors).padStart(6)}`
      )
    }
  }
  if (enforce) {
    let failed = false
    for (const [key, cap] of Object.entries(budget)) {
      const r = rows[key]
      if (r === undefined) {
        console.error(`budget ${key}: no row measured`)
        failed = true
        continue
      }
      const verdict = r.p50 <= cap && r.errors === 0 ? 'ok' : 'OVER'
      if (verdict === 'OVER') {
        failed = true
      }
      console.log(`${verdict.padEnd(4)} ${key} p50=${r.p50}ms budget=${cap}ms errors=${r.errors}`)
    }
    if (failed) {
      process.exit(1)
    }
  }
}

main()
