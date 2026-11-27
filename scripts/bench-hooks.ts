/**
 * bench-hooks — hook-event latency baseline (spec: specs/bro-qbnre.md).
 *
 * Spawns each session-lifecycle hook event N times in a fresh process
 * against a quiet bro-enabled fixture and reports min/p50/p95/max per
 * row as JSON. Four lanes:
 *
 *   runsh:<event>   sh hooks/run.sh — the process plugin hosts exec
 *   dist:<event>    node packages/cli/dist/hooks.js — dispatch minus
 *                   the launcher, so run.sh's share is visible; a dist
 *                   built before the slim entry falls back to
 *                   `index.js hooks` (specs/bro-36sx7.7.md)
 *   noop:<event>    BRO_HOOKS=0 sh hooks/run.sh — the machine-backend
 *                   skip; a spawned-agent tree pays ~nothing (bro-ddksm)
 *   fast:<event>    sh hooks/run.sh on the fast-path fixture — the
 *                   early exit bro-arm83 built; only the per-tool-call
 *                   events run (specs/bro-5tpx0.1.md)
 *
 * "Quiet" = a scratch repo with bro.config.json + a `.beads/` store
 * served by the e2e fake bd/docker: healthy and empty — a real bd's
 * dolt handshake is a property of the store, not of bro's dispatch.
 * The fast lane's fixture drops `.beads/` — a manifest-less store
 * trips run.sh's bead-store barometer and pins NEED_NODE forever —
 * and pre-seeds guards/.stamp so the shell fast path can actually
 * settle (buildFixture below).
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
 * --enforce compares each budgeted row's p50 against its measured noop
 * twin plus a margin derived from the committed absolute budget below.
 * This keeps the process-spawn floor out of the ratchet. Rows without a
 * noop twin fall back to the absolute budget, and any measured row with
 * errors fails — a broken hook is a failure whether or not it carries a
 * latency budget.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_DISPATCH_ERR } from '../packages/cli/src/commands/hook-signal.ts';
import { e2eEnv, initRepo, installFakeBd } from '../packages/cli/src/commands/testrepo.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIST = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const CLI_HOOKS = join(ROOT, 'packages', 'cli', 'dist', 'hooks.js');
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

/** p50 budgets in ms (bead bro-qbnre's initial numbers, extended by
 *  bro-5tpx0.1 to the hot armed rows and the fast lane; E2/E3 tighten).
 *  Keys are `<lane>:<event>` — rows not listed are recorded, not
 *  latency-gated. Armed-path caps carry ~1.5–1.7× headroom over the CI
 *  baseline (run 42977847108: runsh post-tool 240, prompt-submit 251,
 *  pre-tool 175, session-start 370, stop 310; dist ~10–20 ms cheaper).
 *  The fast caps sit BELOW the armed p50 so a fast-path regression that
 *  falls back to Node reads OVER, not as a pass. */
const BUDGET_P50_MS: Record<string, number> = {
  'noop:post-tool': 150,
  'noop:prompt-submit': 150,
  'fast:post-tool': 200,
  'fast:prompt-submit': 200,
  'fast:pre-tool': 300,
  'runsh:post-tool': 400,
  'runsh:prompt-submit': 400,
  'runsh:pre-tool': 300,
  'runsh:session-start': 600,
  'runsh:stop': 600,
  'dist:session-start': 500,
  'dist:stop': 450,
};

/** The existing budgets were set with a quiet-runner noop floor of about
 * 10 ms in mind (the baseline recorded by bro-qbnre). Keep that baseline
 * explicit: a budget below the floor gets a zero additional allowance,
 * while larger budgets contribute only their excess over the floor as
 * hook-work margin. The actual floor is still measured per row/run. */
const TYPICAL_NOOP_FLOOR_MS = 10;

const LANES = ['runsh', 'dist', 'noop', 'fast'] as const;
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
  /** Fast fixture only — a PATH-earlier `node` shim appends the event
   *  arg of every hooks.js/index.js dispatch, one line each. The
   *  early-exit rows must leave their event at zero lines: latency
   *  can't tell a 200 ms dispatch from a fast machine's early exit,
   *  the canary can. */
  nodeLog?: string;
}

interface RunLimits {
  runs: number;
  warmup: number;
}

function percentile(sorted: number[], p: number): number {
  // an empty input indexes -1 → undefined — fold to 0 like min/max do,
  // a fatal row reports zeros, never NaN in the CI artifact
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) {
    return undefined;
  }
  const val = argv[i + 1];
  if (val === undefined || val.startsWith('-')) {
    console.error(`bench-hooks: ${flag} requires an argument`);
    process.exit(2);
  }
  return val;
}

/** Sample-count sanity in one named predicate — the validation rule,
 *  not a stack of operators on an `if`. */
function validCounts(lim: RunLimits): boolean {
  return (
    Number.isInteger(lim.runs) && lim.runs >= 3 && Number.isInteger(lim.warmup) && lim.warmup >= 0
  );
}

function readCounts(argv: string[]): RunLimits {
  const lim = {
    runs: Number(argValue(argv, '--runs') ?? 20),
    warmup: Number(argValue(argv, '--warmup') ?? 1),
  };
  if (!validCounts(lim)) {
    console.error('bench-hooks: need --runs ≥3 and --warmup ≥0');
    process.exit(2);
  }
  return lim;
}

function readLanes(argv: string[]): Lane[] {
  const rawLanes = argValue(argv, '--lanes')?.split(',') ?? [...LANES];
  const bad = rawLanes.filter(l => !(LANES as readonly string[]).includes(l));
  if (bad.length > 0) {
    console.error(
      `bench-hooks: unknown --lanes ${bad.join(',')} — expected a comma-list of ${LANES.join(', ')}`
    );
    process.exit(2);
  }
  return rawLanes as Lane[];
}

function parseArgs(argv: string[]): Options {
  const lim = readCounts(argv);
  return {
    runs: lim.runs,
    warmup: lim.warmup,
    out: argValue(argv, '--out'),
    budgetFile: argValue(argv, '--budget'),
    enforce: argv.includes('--enforce'),
    asJson: argv.includes('--json'),
    lanes: readLanes(argv),
  };
}

function loadBudget(opts: Options): Record<string, number> {
  if (opts.budgetFile === undefined) {
    return BUDGET_P50_MS;
  }
  try {
    const parsed = JSON.parse(readFileSync(opts.budgetFile, 'utf8')) as Record<string, unknown>;
    for (const [key, cap] of Object.entries(parsed)) {
      if (typeof cap !== 'number' || !Number.isFinite(cap)) {
        console.error(`bench-hooks: budget ${key} must be a finite number of ms`);
        process.exit(2);
      }
    }
    return { ...BUDGET_P50_MS, ...(parsed as Record<string, number>) };
  } catch (e) {
    console.error(
      `bench-hooks: cannot read --budget ${opts.budgetFile} — ${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(2);
  }
}

/** The fixture families lanes draw from — 'armed' is the original
 *  quiet repo (a manifest-less `.beads` defers every fast-path check,
 *  so the lane always pays Node), 'fast' is the variant the shell
 *  early-exit can settle (specs/bro-5tpx0.1.md). */
type FixtureKind = 'armed' | 'fast';

/** Quiet fixture: opted-in repo, scrubbed env. The 'armed' kind adds a
 *  healthy-empty beads store served by the e2e fake bd/docker. The
 *  'fast' kind carries bro.config.json only — no `.beads`, so the
 *  bead-store barometer demands no manifest and the lessons/drills
 *  cache snapshots are never consulted — plus a pre-seeded
 *  guards/.stamp: fresh session ids per run keep per-session markers
 *  from accumulating, so the fast path can only rely on repo-level
 *  stamps that persist across runs. The stamp's bare-newline body is
 *  recordGuardEvents' zero-coverage form (no event names, no .trace),
 *  and it lands after every config file so no CFGS entry is newer.
 *  BRO_HOOKS_NO_FALLBACK pins run.sh to the in-tree dist so a broken
 *  build can never hide behind a PATH-bro or npx fallback. */
function writeNodeShim(binDir: string, nodeLog: string): void {
  const shim = join(binDir, 'node');
  writeFileSync(
    shim,
    '#!/bin/sh\n' +
      'case "$1" in\n' +
      '  */hooks.js|*/index.js)\n' +
      '    for _l do :; done\n' +
      `    printf '%s\\n' "$_l" >> ${JSON.stringify(nodeLog)}\n` +
      '    ;;\n' +
      'esac\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`
  );
  chmodSync(shim, 0o755);
}

function buildFixture(kind: FixtureKind): Fixture {
  const { root, main } = initRepo(`bro-bench-hooks-${kind}-`, m => {
    writeFileSync(join(m, 'bro.config.json'), '{}\n');
    if (kind === 'armed') {
      mkdirSync(join(m, '.beads'), { recursive: true });
      writeFileSync(join(m, '.beads', 'beads.json'), '{"rows":[]}\n');
    }
    mkdirSync(join(m, 'home'), { recursive: true });
  });
  if (kind === 'fast') {
    // <git-common>/bro/hooks/guards — the main checkout's common dir is
    // its own .git
    const gdir = join(main, '.git', 'bro', 'hooks', 'guards');
    mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, '.stamp'), '\n');
  }
  const { binDir, db } = installFakeBd(root, []);
  let nodeLog: string | undefined;
  if (kind === 'fast') {
    // mechanism canary: a `node` shim first on PATH logs the last argv
    // of every hooks.js/index.js dispatch, then defers to the real
    // node — zero cost on the early exit, and any logged post-tool/
    // prompt-submit line is proof the fast path fell through to Node
    // inside the latency budget (sourcery finding on the PR)
    nodeLog = join(root, 'node-dispatch.log');
    writeFileSync(nodeLog, '');
    writeNodeShim(binDir, nodeLog);
  }
  const env = e2eEnv({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
    HOME: join(main, 'home'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    BRO_TELEMETRY: '0',
    BRO_HOOKS_NO_FALLBACK: '1',
  });
  return { cwd: main, env, nodeLog };
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
      ? existsSync(CLI_HOOKS)
        ? // the slim entry run.sh prefers — argv is already the
          // post-`hooks` spelling (specs/bro-36sx7.7.md)
          [process.execPath, [CLI_HOOKS, spec.event]]
        : [process.execPath, [CLI_DIST, 'hooks', spec.event]]
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

/** Shared fatal-stop loop: attempt samples while none is fatal,
 *  handing each non-fatal attempt to `use`. Returns the fatal detail,
 *  '' when clean. */
interface AttemptsRun {
  spec: RowSpec;
  fx: Fixture;
  count: number;
  offset: number;
  use: (a: Attempt, i: number) => void;
}

function runAttempts(run: AttemptsRun): string {
  const { spec, fx, count, offset, use } = run;
  let fatalDetail = '';
  for (let i = offset; i < offset + count && fatalDetail === ''; i += 1) {
    const a = attempt(spec, rowInput(spec, i), fx);
    if (a.fatal) {
      fatalDetail = a.detail;
    } else {
      use(a, i);
    }
  }
  return fatalDetail;
}

/** Warmup samples — failures are logged, never gated; a fatal attempt
 *  stops the phase early. Returns the fatal detail, '' when clean. */
function warmupPhase(spec: RowSpec, fx: Fixture, lim: RunLimits): string {
  return runAttempts({
    spec,
    fx,
    count: lim.warmup,
    offset: 0,
    use: a => {
      if (!a.ok) {
        console.error(`bench-hooks: ${rowKey(spec)} warmup failed — ${a.detail}`);
      }
    },
  });
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
  out.fatalDetail = runAttempts({
    spec,
    fx,
    count: lim.runs,
    offset: lim.warmup,
    use: (a, i) => {
      out.times.push(a.ms);
      out.errors += noteError(a, { key: rowKey(spec), i, prior: out.errors });
    },
  });
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

/** The fast lane measures only the per-tool-call contract: post-tool
 *  and prompt-submit can settle in shell; pre-tool never fast-paths
 *  (the session-cap veto stays live in every mode) so it records the
 *  armed floor on the same minimal repo — the number the fast rows
 *  must stay under. */
const FAST_EVENTS = new Set(['post-tool', 'prompt-submit', 'pre-tool']);

function laneEvents(lane: Lane): typeof EVENTS {
  return lane === 'fast' ? EVENTS.filter(e => FAST_EVENTS.has(e.event)) : EVENTS;
}

/** Lines the fast fixture's node shim logged for `event` — zero for
 *  the early-exit rows. Each event is benched once per fixture, so the
 *  count covers exactly this row's warmup + measured runs. */
function dispatchCount(nodeLog: string | undefined, event: string): number {
  if (nodeLog === undefined || !existsSync(nodeLog)) {
    return 0;
  }
  return readFileSync(nodeLog, 'utf8')
    .split('\n')
    .filter(l => l === event).length;
}

/** Fixtures build lazily per kind — a `--lanes fast` run must not pay
 *  for the armed repo's fake-bd store, and vice versa. */
function runBench(opts: Options): Map<string, Row> {
  const rows = new Map<string, Row>();
  const lim = { runs: opts.runs, warmup: opts.warmup };
  const fixtures: Partial<Record<FixtureKind, Fixture>> = {};
  for (const lane of opts.lanes) {
    const kind: FixtureKind = lane === 'fast' ? 'fast' : 'armed';
    const fx = fixtures[kind] ?? buildFixture(kind);
    fixtures[kind] = fx;
    const laneEnv = lane === 'noop' ? { ...fx.env, BRO_HOOKS: '0' } : fx.env;
    const laneFx = { cwd: fx.cwd, env: laneEnv };
    for (const { event, payload } of laneEvents(lane)) {
      const row = benchRow({ lane, event, payload }, laneFx, lim);
      // mechanism proof for the early-exit rows: any node dispatch is
      // a fast-path regression even when it lands inside the p50 cap —
      // count it into errors so the row fails like a broken hook
      if (
        lane === 'fast' &&
        (event === 'post-tool' || event === 'prompt-submit') &&
        row.errors === 0
      ) {
        const dispatches = dispatchCount(fx.nodeLog, event);
        if (dispatches > 0) {
          console.error(
            `bench-hooks: fast:${event} reached node ${dispatches}× — the early exit did not settle`
          );
          row.errors += dispatches;
        }
      }
      rows.set(`${lane}:${event}`, row);
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
    const opts = { cwd: ROOT, encoding: 'utf8' as const };
    return spawnSync('git', ['rev-parse', '--short', 'HEAD'], opts).stdout.trim(); // NOSONAR — PATH lookup is the contract
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
      fixture:
        'armed: bro.config.json + empty fake-bd store; fast: bro.config.json only + seeded guards/.stamp',
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
export interface Verdict {
  line: string;
  failed: boolean;
}

export interface BudgetRow {
  p50: number;
  errors: number;
}

export function budgetVerdict(
  b: { key: string; cap: number },
  r: BudgetRow | undefined,
  noopTwin: BudgetRow | undefined
): Verdict {
  if (r === undefined) {
    return { line: `budget ${b.key}: no row measured`, failed: true };
  }
  const margin = Math.max(0, b.cap - TYPICAL_NOOP_FLOOR_MS);
  const floorRelative = noopTwin !== undefined;
  const delta = floorRelative ? r.p50 - noopTwin.p50 : undefined;
  const latencyOver = floorRelative ? delta > margin : r.p50 > b.cap;
  const ok = !latencyOver && r.errors === 0;
  const tag = ok ? 'ok' : 'OVER';
  const relative = floorRelative
    ? ` floor=${noopTwin.p50}ms delta=${delta}ms margin=${margin}ms`
    : ' floor=missing (absolute fallback)';
  return {
    line: `${tag.padEnd(4)} ${b.key} p50=${r.p50}ms budget=${b.cap}ms${relative} errors=${r.errors}`,
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

/** Did `<lane>:<event>`'s lane run — a budget key on an unselected
 *  lane is skipped, never failed (`--lanes runsh` must not be gated on
 *  unmeasured fast rows). A key on a SELECTED lane with an event the
 *  lane never measures is not skipped — it falls through to the 'no
 *  row measured' verdict, so a misspelt or impossible key still trips. */
function laneInScope(key: string, opts: Options): boolean {
  const [lane] = key.split(':');
  return (opts.lanes as string[]).includes(lane);
}

/** The CI ratchet: budgeted rows must hold p50 with zero errors, and
 *  ANY measured row with errors fails. Budget keys on unselected lanes
 *  are reported as skips, not verdicts. Verdicts go to the injected
 *  sink — stderr under --json so stdout stays parseable, stdout
 *  otherwise. Returns true on failure. */
function enforce(
  rows: Map<string, Row>,
  budget: Record<string, number>,
  opts: Options,
  say: (line: string) => void
): boolean {
  let failed = false;
  for (const [key, cap] of Object.entries(budget)) {
    if (!laneInScope(key, opts)) {
      say(`skip ${key} — lane not in --lanes`);
      continue;
    }
    const [, event] = key.split(':');
    const v = budgetVerdict({ key, cap }, rows.get(key), rows.get(`noop:${event}`));
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
  if (!existsSync(CLI_DIST) && !existsSync(CLI_HOOKS)) {
    console.error('bench-hooks: packages/cli/dist is missing — run `npm run build` first');
    process.exit(2);
  }
  const budget = loadBudget(opts);
  const rows = runBench(opts);
  writeReport(rows, budget, opts);
  const say = opts.asJson
    ? (line: string) => console.error(line)
    : (line: string) => console.log(line);
  if (opts.enforce && enforce(rows, budget, opts, say)) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
