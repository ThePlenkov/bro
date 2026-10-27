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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eEnv, initRepo, installFakeBd } from '../packages/cli/src/commands/testrepo.ts';
import { HOOK_DISPATCH_ERR } from '../packages/cli/src/commands/hook-signal.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIST = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const RUN_SH = join(ROOT, 'hooks', 'run.sh');

/** Session-lifecycle events only — git-hook entries (prepare-commit-msg
 *  et al.) are a different contract and never on the per-tool-call
 *  path. Each payload is `{session_id, ...extra}` — the events differ
 *  only in their extra fields. */
const EVENT_SPECS: { event: string; extra: Record<string, unknown> }[] = [
  { event: 'session-start', extra: {} },
  { event: 'post-compaction', extra: {} },
  { event: 'pre-compact', extra: {} },
  { event: 'prompt-submit', extra: { prompt: 'bench prompt' } },
  {
    event: 'pre-tool',
    extra: { tool_name: 'exec', tool_input: { command: 'ls' } },
  },
  {
    event: 'post-tool',
    extra: {
      tool_name: 'read',
      tool_input: { file_path: 'x' },
      tool_response: { success: true },
    },
  },
  { event: 'stop', extra: {} },
  {
    event: 'permission',
    extra: { tool_name: 'exec', tool_input: { command: 'ls' } },
  },
];
const EVENTS = EVENT_SPECS.map(e => ({
  event: e.event,
  payload: (sid: string): unknown => ({ session_id: sid, ...e.extra }),
}));

/** p50 budgets in ms (bead bro-qbnre's initial numbers; E2/E3 tighten
 *  and extend). Keys are `<lane>:<event>` — rows not listed are
 *  recorded, not latency-gated. */
const BUDGET_P50_MS: Record<string, number> = {
  'noop:post-tool': 150,
  'noop:prompt-submit': 150,
  'runsh:session-start': 600,
  'runsh:stop': 600,
};

const LANES = ['runsh', 'dist', 'noop'] as const;
type Lane = (typeof LANES)[number];

interface Row {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  errors: number;
}

interface Options {
  runs: number;
  warmup: number;
  out: string | undefined;
  budgetFile: string | undefined;
  enforce: boolean;
  asJson: boolean;
  lanes: Lane[];
}

/** One row to measure — the lane/event/payload triple travels as a
 *  unit through attempt, rowInput and benchRow. */
interface RowSpec {
  lane: Lane;
  event: string;
  payload: (sid: string) => unknown;
}

interface Fixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface RunLimits {
  runs: number;
  warmup: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Sample-count sanity in one named predicate — the validation rule,
 *  not a stack of operators on an `if`. */
function validCounts(lim: RunLimits): boolean {
  return (
    Number.isFinite(lim.runs) && lim.runs >= 3 && Number.isFinite(lim.warmup) && lim.warmup >= 0
  );
}

function parseArgs(argv: string[]): Options {
  const lim = {
    runs: Number(argValue(argv, '--runs') ?? 20),
    warmup: Number(argValue(argv, '--warmup') ?? 1),
  };
  if (!validCounts(lim)) {
    console.error('bench-hooks: need --runs ≥3 and --warmup ≥0');
    process.exit(2);
  }
  const rawLanes = argValue(argv, '--lanes')?.split(',') ?? [...LANES];
  const bad = rawLanes.filter(l => !(LANES as readonly string[]).includes(l));
  if (bad.length > 0) {
    console.error(
      `bench-hooks: unknown --lanes ${bad.join(',')} — expected a comma-list of ${LANES.join(', ')}`
    );
    process.exit(2);
  }
  return {
    runs: lim.runs,
    warmup: lim.warmup,
    out: argValue(argv, '--out'),
    budgetFile: argValue(argv, '--budget'),
    enforce: argv.includes('--enforce'),
    asJson: argv.includes('--json'),
    lanes: rawLanes as Lane[],
  };
}

function loadBudget(opts: Options): Record<string, number> {
  if (opts.budgetFile === undefined) {
    return BUDGET_P50_MS;
  }
  try {
    const parsed = JSON.parse(readFileSync(opts.budgetFile, 'utf8')) as Record<string, number>;
    return { ...BUDGET_P50_MS, ...parsed };
  } catch (e) {
    console.error(
      `bench-hooks: cannot read --budget ${opts.budgetFile} — ${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(2);
  }
}

/** Quiet fixture: opted-in repo, healthy-empty beads store, scrubbed
 *  env. BRO_HOOKS_NO_FALLBACK pins run.sh to the in-tree dist so a
 *  broken build can never hide behind a PATH-bro or npx fallback. */
function buildFixture(): Fixture {
  const { root, main } = initRepo('bro-bench-hooks-', m => {
    writeFileSync(join(m, 'bro.config.json'), '{}\n');
    mkdirSync(join(m, '.beads'), { recursive: true });
    writeFileSync(join(m, '.beads', 'beads.json'), '{"rows":[]}\n');
    mkdirSync(join(m, 'home'), { recursive: true });
  });
  const { binDir, db } = installFakeBd(root, []);
  const env = e2eEnv({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
    HOME: join(main, 'home'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    BRO_TELEMETRY: '0',
    BRO_HOOKS_NO_FALLBACK: '1',
  });
  return { cwd: main, env };
}

interface Attempt {
  ms: number;
  ok: boolean;
  detail: string;
  /** spawn error or the 30s kill — retrying re-pays the same hang. */
  fatal: boolean;
}

/** One spawn — wall clock is the metric (process spawn + boot +
 *  dispatch is what the host pays). A run is an error on non-zero
 *  exit, a spawn error/timeout, or the HOOK_DISPATCH_ERR marker — the
 *  hook's fail-open contract keeps exit 0 on a dispatch throw, so the
 *  stderr line is the only signal a watchdog can count. */
function attempt(spec: RowSpec, input: string | undefined, fx: Fixture): Attempt {
  const [command, args]: [string, string[]] =
    spec.lane === 'dist'
      ? [process.execPath, [CLI_DIST, 'hooks', spec.event]]
      : ['sh', [RUN_SH, spec.event]];
  const t0 = performance.now();
  const proc = spawnSync(command, args, {
    cwd: fx.cwd,
    input,
    env: fx.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ms = performance.now() - t0;
  const stderr = typeof proc.stderr === 'string' ? proc.stderr : '';
  const ok = proc.status === 0 && proc.error === undefined && !stderr.includes(HOOK_DISPATCH_ERR);
  const detail = `status=${proc.status} signal=${proc.signal} err=${proc.error?.message ?? ''} stderr=${stderr.slice(0, 300)}`;
  return { ms, ok, detail, fatal: proc.error !== undefined };
}

/** stdin for one attempt — a fresh session id per run, since the trace
 *  journal and skill-hinted markers are per-session; reusing one id
 *  lets later runs measure a different session's accumulated state.
 *  noop skips stdin: with BRO_HOOKS=0 run.sh exits before reading it
 *  for every event but permission, so writing the payload would race
 *  the exit (EPIPE). */
function rowInput(spec: RowSpec, i: number): string | undefined {
  const skipped = spec.lane === 'noop' && spec.event !== 'permission';
  return skipped ? undefined : JSON.stringify(spec.payload(`${spec.lane}-${spec.event}-${i}`));
}

/** Measured-error accounting — the first failure's detail is the only
 *  one logged; N copies of the same break are noise. */
interface ErrCtx {
  key: string;
  i: number;
  prior: number;
}
function noteError(a: Attempt, ctx: ErrCtx): number {
  if (a.ok) {
    return 0;
  }
  if (ctx.prior === 0) {
    console.error(`bench-hooks: ${ctx.key} run ${ctx.i} failed — ${a.detail}`);
  }
  return 1;
}

function rowKey(spec: RowSpec): string {
  return `${spec.lane}:${spec.event}`;
}

/** Warmup samples — failures are logged, never gated; a fatal attempt
 *  stops the phase early. Returns the fatal detail, '' when clean. */
function warmupPhase(spec: RowSpec, fx: Fixture, lim: RunLimits): string {
  let fatalDetail = '';
  for (let i = 0; i < lim.warmup && fatalDetail === ''; i += 1) {
    const a = attempt(spec, rowInput(spec, i), fx);
    if (a.fatal) {
      fatalDetail = a.detail;
    } else if (!a.ok) {
      console.error(`bench-hooks: ${rowKey(spec)} warmup failed — ${a.detail}`);
    }
  }
  return fatalDetail;
}

interface Measured {
  times: number[];
  errors: number;
  fatalDetail: string;
}

/** Measured samples — errors count toward the row verdict; a fatal
 *  attempt stops the phase early. */
function measuredPhase(spec: RowSpec, fx: Fixture, lim: RunLimits): Measured {
  const out: Measured = { times: [], errors: 0, fatalDetail: '' };
  for (let i = lim.warmup; i < lim.warmup + lim.runs && out.fatalDetail === ''; i += 1) {
    const a = attempt(spec, rowInput(spec, i), fx);
    if (a.fatal) {
      out.fatalDetail = a.detail;
    } else {
      out.times.push(a.ms);
      out.errors += noteError(a, { key: rowKey(spec), i, prior: out.errors });
    }
  }
  return out;
}

/** A row's `errors` counts measured runs only — warmup failures are
 *  logged but never gated: a discarded sample must not decide CI.
 *  A fatal attempt (spawn failure or the 30s kill) aborts the row —
 *  retrying re-pays the same hang (24 rows × 21 × 30s tops ~4h on a
 *  dead hook); it counts once even in warmup, an empty row must not
 *  read as clean. */
function benchRow(spec: RowSpec, fx: Fixture, lim: RunLimits): Row {
  const warmup = warmupPhase(spec, fx, lim);
  const m =
    warmup === ''
      ? measuredPhase(spec, fx, lim)
      : { times: [] as number[], errors: 0, fatalDetail: warmup };
  const errors = m.errors + (m.fatalDetail === '' ? 0 : 1);
  if (m.fatalDetail !== '') {
    console.error(`bench-hooks: ${rowKey(spec)} aborting — ${m.fatalDetail}`);
  }
  m.times.sort((a, b) => a - b);
  return {
    n: m.times.length,
    min: Math.round(m.times[0] ?? 0),
    p50: Math.round(percentile(m.times, 0.5)),
    p95: Math.round(percentile(m.times, 0.95)),
    max: Math.round(m.times.at(-1) ?? 0),
    errors,
  };
}

function runBench(opts: Options, fx: Fixture): Map<string, Row> {
  const rows = new Map<string, Row>();
  const lim = { runs: opts.runs, warmup: opts.warmup };
  for (const lane of opts.lanes) {
    const laneEnv = lane === 'noop' ? { ...fx.env, BRO_HOOKS: '0' } : fx.env;
    const laneFx = { cwd: fx.cwd, env: laneEnv };
    for (const { event, payload } of EVENTS) {
      rows.set(`${lane}:${event}`, benchRow({ lane, event, payload }, laneFx, lim));
    }
  }
  return rows;
}

function printTable(rows: Map<string, Row>): void {
  console.log('row                                 n    min    p50    p95    max  errors');
  for (const [k, r] of rows) {
    console.log(
      `${k.padEnd(34)} ${String(r.n).padStart(3)} ${String(r.min).padStart(6)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.errors).padStart(6)}`
    );
  }
}

/** Report metadata — the bench runs inside a checkout, so `git` is
 *  resolved on PATH by contract (same rule as codescene-check.ts). */
function headSha(): string {
  try {
    return spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      // NOSONAR — PATH lookup is the contract
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim();
  } catch {
    // reporting metadata only
    return '';
  }
}

/** stdout carries the table, or the JSON report in --json mode — never
 *  both, so `--json` output always parses. --out writes the file in
 *  either mode. */
function writeReport(rows: Map<string, Row>, budget: Record<string, number>, opts: Options): void {
  const report = {
    meta: {
      ts: new Date().toISOString(),
      sha: headSha(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      runs: opts.runs,
      warmup: opts.warmup,
      fixture: 'quiet (bro.config.json + empty fake-bd store)',
    },
    rows: Object.fromEntries(rows),
    budget,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out !== undefined) {
    writeFileSync(opts.out, json);
  }
  if (opts.asJson) {
    process.stdout.write(json);
  } else {
    printTable(rows);
  }
}

/** One budget line's verdict — pure data so `enforce` only prints. */
interface Verdict {
  line: string;
  failed: boolean;
}

function budgetVerdict(b: { key: string; cap: number }, r: Row | undefined): Verdict {
  if (r === undefined) {
    return { line: `budget ${b.key}: no row measured`, failed: true };
  }
  const ok = r.p50 <= b.cap && r.errors === 0;
  const tag = ok ? 'ok' : 'OVER';
  return {
    line: `${tag.padEnd(4)} ${b.key} p50=${r.p50}ms budget=${b.cap}ms errors=${r.errors}`,
    failed: !ok,
  };
}

/** Rows with measured errors and no budget — a broken hook is a
 *  failure whether or not it carries a latency budget. */
function strayErrors(rows: Map<string, Row>, budget: Record<string, number>): Verdict[] {
  const out: Verdict[] = [];
  for (const [key, r] of rows) {
    if (r.errors === 0) continue;
    if (key in budget) continue;
    out.push({
      line: `ERR  ${key} errors=${r.errors} — unbudgeted row with failures`,
      failed: true,
    });
  }
  return out;
}

/** The CI ratchet: budgeted rows must hold p50 with zero errors, and
 *  ANY measured row with errors fails. Verdicts go to the injected
 *  sink — stderr under --json so stdout stays parseable, stdout
 *  otherwise. Returns true on failure. */
function enforce(
  rows: Map<string, Row>,
  budget: Record<string, number>,
  say: (line: string) => void
): boolean {
  let failed = false;
  for (const [key, cap] of Object.entries(budget)) {
    const v = budgetVerdict({ key, cap }, rows.get(key));
    say(v.line);
    failed = failed || v.failed;
  }
  for (const v of strayErrors(rows, budget)) {
    say(v.line);
    failed = true;
  }
  return failed;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(CLI_DIST)) {
    console.error('bench-hooks: packages/cli/dist is missing — run `npm run build` first');
    process.exit(2);
  }
  const budget = loadBudget(opts);
  const fx = buildFixture();
  const rows = runBench(opts, fx);
  writeReport(rows, budget, opts);
  const say = opts.asJson
    ? (line: string) => console.error(line)
    : (line: string) => console.log(line);
  if (opts.enforce && enforce(rows, budget, say)) {
    process.exit(1);
  }
}

main();
