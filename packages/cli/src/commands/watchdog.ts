/**
 * `bro watchdog` — the launch brief for the pipeline's infinite read-only
 * orchestration loop (the watchdog). Two halves, deliberately split:
 *
 *   bro watchdog           human brief: launch steps + measured baselines
 *   bro watchdog --json    {ts, skill, baselines} — the same facts, machine-readable
 *
 * The LOOP is model work — one background tick subagent at a time, READ-ONLY
 * to the bone, the next tick chained only after the previous one closes with
 * a WAKE|TIMEOUT verdict — and lives in the `watchdog` skill, where a prompt
 * belongs. This command owns the other half: the tick-0 baseline, measured at
 * call time. A watchdog that quotes remembered numbers fabricates the one
 * thing it exists to prevent, so every figure below comes from a probe run
 * right now — and the probes are the same ones a tick runs (systemctl show,
 * `gh pr list --limit 100`, wc/grep semantics over loop.out), so the brief
 * and the first tick quote one baseline, not two.
 *
 * Degradation is the contract: no systemd, no gh, no /proc — the missing
 * plane prints `unavailable (<why>)` and the brief still launches. A
 * launcher that throws when a probe is missing is worse than one that
 * admits what it could not measure.
 *
 * Read-only by construction — every probe is a read (`systemctl show`,
 * `git worktree list`, `gh pr list`, statfs, /proc/meminfo, the loop/daemon
 * records). Nothing here claims, pushes, merges, kills or cleans: cleaning
 * /tmp is the operator's/assistant's job, never the watchdog's.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir, gitTry, hasHelpFlag, pidAlive, printUsage } from '@broject/core';
import { collectLoopRuns, loopRunsDir, type LoopRunView } from './loop-state.ts';
import { daemonLogPath, readDaemonRecord } from './daemon.ts';

/** The skill this brief points at — the loop protocol lives there, the
 *  facts live here. `--json` carries it so a tool can find the skill
 *  without hardcoding the name. */
export const WATCHDOG_SKILL = 'watchdog';

/** Our PRs — the classification every tick re-applies to a PR that appears
 *  mid-window. Kept identical in the `watchdog` skill's prose; this side is
 *  the measured baseline, that side is the mid-window classifier. */
const OURS = /^(loop\/|fix\/bro-|stack\/|work\/bro-)/;

const UNIT = 'bro-loop';
const DISK_PATH = '/tmp';
const PR_LIMIT = 100;
const PR_ARGS = [
  'pr',
  'list',
  '--state',
  'open',
  '--limit',
  String(PR_LIMIT),
  '--json',
  'number,headRefName',
];
/** A launcher degrades, it does not hang: gh gets a hard bound of its own
 *  (the repo-wide `ghTry` has none). */
const GH_TIMEOUT_MS = 10_000;

export interface Unavailable {
  unavailable: string;
}
export interface WatchdogUnit {
  state: string;
  mainPid: number | null;
  nRestarts: number | null;
}
export interface WatchdogDaemon {
  /** `daemon.json`'s recorded armer — null when nothing armed the daemon */
  pid: number | null;
  /** null = no record to check; a record whose pid is gone is the alarm */
  alive: boolean | null;
  logAgeSec: number | null;
  etimedout: number | null;
}
export interface WatchdogLog {
  lines: number;
  ageSec: number | null;
  etimedout: number | null;
}
export interface WatchdogPrs {
  open: number;
  ours: number;
  foreign: number;
}
export interface WatchdogDisk {
  path: string;
  usePercent: number;
}
export interface WatchdogMemory {
  swapUsedBytes: number;
  memAvailableBytes: number;
}
export interface WatchdogWorktrees {
  count: number;
}
export interface WatchdogSlot {
  slug: string;
  beadId: string;
  pid: number | null;
  state: 'running' | 'dead';
  silentMs: number | null;
}
export interface WatchdogBaselines {
  ts: string;
  unit: WatchdogUnit | Unavailable;
  daemon: WatchdogDaemon | Unavailable;
  loopOut: WatchdogLog | Unavailable;
  prs: WatchdogPrs | Unavailable;
  disk: WatchdogDisk | Unavailable;
  memory: WatchdogMemory | Unavailable;
  worktrees: WatchdogWorktrees | Unavailable;
  /** Loop run records genuinely in flight — alive AND not stamped with
   *  the loop's own pid (a worker is never the supervisor; records that
   *  are, are residue of a run that never settled). `unavailable` when
   *  the records directory exists but cannot be read — unreadable is NOT
   *  "none in flight" (CodeRabbit): the brief must not claim a quiet
   *  lane it could not observe. */
  slots: WatchdogSlot[] | Unavailable;
  /** Loop run records that are NOT in flight: dead pids plus the
   *  supervisor-stamped ones. Surfaced instead of silently dropped —
   *  residue is a fact about the loop, not noise to hide. */
  residue: number;
}

const unavailable = (why: string): Unavailable => ({ unavailable: why });

const isUnavailable = <T>(v: T | Unavailable): v is Unavailable =>
  typeof v === 'object' && v !== null && 'unavailable' in v;

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const firstLine = (text: string): string => {
  const line = text.split('\n').find(l => l.trim() !== '') ?? '';
  return line.trim().slice(0, 120);
};

const ageSec = (mtimeMs: number, now: number): number =>
  Math.max(0, Math.round((now - mtimeMs) / 1000));

/** Line count + the last-ETIMEDOUT line number over an append-only log,
 *  scanned in fixed byte chunks: neither loop.out nor daemon.log has a
 *  size cap, so a full read would scale memory with uptime (CodeRabbit).
 *  Newlines and the ASCII needle are byte operations — no decoding, no
 *  UTF-8 boundary hazards (continuation bytes are ≥0x80 and can never be
 *  0x0A or part of the needle). `lines` is the newline count — exactly
 *  what `wc -l` reports, including for an unterminated final line.
 *  The reader is injected so tests drive chunk boundaries directly. */
const LOG_CHUNK = 64 * 1024;
const NEEDLE = Buffer.from('ETIMEDOUT');

/** Newlines in `buf[0..end)` (whole buffer by default) — one flat loop,
 *  so the scan loop never nests a counting loop inside itself (CodeScene
 *  depth ceiling): the line number of a match at `end` is
 *  `countNewlines(...) + 1`. */
const countNewlines = (buf: Buffer, end: number = buf.length): number => {
  let n = 0;
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0x0a) {
      n++;
    }
  }
  return n;
};

export function scanLog(readChunk: (buffer: Buffer) => number): {
  lines: number;
  etimedout: number | null;
} {
  const buf = Buffer.allocUnsafe(LOG_CHUNK);
  const overlap = NEEDLE.length - 1;
  let linesBefore = 0;
  let etimedout: number | null = null;
  let tail = Buffer.alloc(0);
  for (;;) {
    const bytes = readChunk(buf);
    if (bytes <= 0) {
      break;
    }
    const chunk = buf.subarray(0, bytes);
    // the window carries up to `overlap` bytes of PRIOR data — enough for
    // a needle to start in any earlier byte and finish in this chunk,
    // even when chunks are smaller than the needle itself
    const window = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
    const at = window.lastIndexOf(NEEDLE);
    if (at !== -1) {
      etimedout = linesBefore - countNewlines(tail) + countNewlines(window, at) + 1;
    }
    linesBefore += countNewlines(chunk);
    // concat allocates, so the subarray view below is safe to retain —
    // unlike a view into the reused read buffer
    tail = Buffer.concat([tail, chunk]).subarray(-overlap);
  }
  return { lines: linesBefore, etimedout };
}

/** `scanLog` over a real file — null when it cannot be opened (the
 *  caller degrades the plane rather than reporting a fabricated zero). */
function scanLogFile(path: string): { lines: number; etimedout: number | null } | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    let pos = 0;
    return scanLog(buffer => {
      try {
        const n = readSync(fd, buffer, 0, buffer.length, pos);
        pos += n;
        return n;
      } catch {
        return -1;
      }
    });
  } finally {
    closeSync(fd);
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** `systemctl --user show bro-loop` output, or null when the unit row
 *  could not be read — spawn and parse live apart so each stays under
 *  the complexity ceiling (CodeScene), with no compound conditions. */
function spawnUnitRow(): string | null {
  try {
    const r = spawnSync(
      'systemctl', // NOSONAR — user-installed CLI, PATH lookup intended (the same stance gh/git take in @broject/core)
      ['--user', 'show', UNIT, '-p', 'ActiveState,MainPID,NRestarts'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (r.error !== undefined) {
      return null;
    }
    if (r.status !== 0) {
      return null;
    }
    if (!r.stdout) {
      return null;
    }
    return r.stdout;
  } catch {
    return null;
  }
}

function parseUnitRow(stdout: string): WatchdogUnit | Unavailable {
  const kv = new Map(
    stdout.split('\n').map(l => {
      const i = l.indexOf('=');
      return [i === -1 ? l : l.slice(0, i), i === -1 ? '' : l.slice(i + 1)] as const;
    })
  );
  const state = kv.get('ActiveState');
  if (state === undefined || state === '') {
    return unavailable('no ActiveState in systemctl output');
  }
  const num = (key: string): number | null => {
    const v = Number(kv.get(key));
    return Number.isFinite(v) && v !== 0 ? v : null;
  };
  return {
    state,
    mainPid: num('MainPID'),
    nRestarts: kv.get('NRestarts') === '0' ? 0 : num('NRestarts'),
  };
}

function readUnit(): WatchdogUnit | Unavailable {
  const stdout = spawnUnitRow();
  if (stdout === null) {
    return unavailable('systemctl unavailable');
  }
  return parseUnitRow(stdout);
}

/** `gh pr list --state open --limit 100 --json …` spawn — its own
 *  `spawnSync` with a hard timeout instead of the repo's `ghTry`: a
 *  launcher must degrade to `unavailable`, never hang on a stalled
 *  network (cubic P2). */
type SpawnResult = { ok: true; out: string } | { ok: false; why: string };

function spawnOpenPrs(dir: string): SpawnResult {
  try {
    const r = spawnSync(
      'gh', // NOSONAR — PATH lookup is the contract (same as gh/glab in @broject/core)
      PR_ARGS,
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (r.error !== undefined) {
      return { ok: false, why: r.error.message };
    }
    if (r.status !== 0) {
      const why = firstLine(r.stderr ?? '') || `exit ${r.status}`;
      return { ok: false, why };
    }
    if (!r.stdout) {
      return { ok: false, why: 'empty output' };
    }
    return { ok: true, out: r.stdout };
  } catch (err) {
    return { ok: false, why: msg(err) };
  }
}

function readPrs(dir: string): WatchdogPrs | Unavailable {
  const spawned = spawnOpenPrs(dir);
  if (!spawned.ok) {
    return unavailable(`gh pr list failed: ${spawned.why}`);
  }
  try {
    const rows = JSON.parse(spawned.out) as Array<{ number?: number; headRefName?: string }>;
    if (!Array.isArray(rows)) {
      return unavailable('gh pr list returned a non-array');
    }
    const ours = rows.filter(p => OURS.test(p.headRefName ?? '')).length;
    return { open: rows.length, ours, foreign: rows.length - ours };
  } catch (err) {
    return unavailable(`gh pr list unreadable: ${msg(err)}`);
  }
}

/** statfs over the watched tmpfs — df's Use% in one syscall. The formula
 *  is df's own, measured against this box rather than reasoned: on `/`
 *  (ext4, ~5% reserved) df prints 14%, `(blocks-bfree)/blocks` reads 13
 *  and the reserved-blocks shortcut `(blocks-bavail)/blocks` reads 18 —
 *  only `ceil(used / (used + avail))` reproduces 14 (and tmpfs's 72).
 *  Non-POSIX or a vanished mount degrades. */
function readDisk(path: string = DISK_PATH): WatchdogDisk | Unavailable {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize;
    const used = total - s.bfree * s.bsize;
    const avail = s.bavail * s.bsize;
    const denominator = used + avail;
    if (denominator <= 0) {
      return unavailable(`statfs(${path}) reports an empty filesystem`);
    }
    const usePercent = Math.min(100, Math.ceil((used / denominator) * 100));
    return { path, usePercent };
  } catch (err) {
    return unavailable(`statfs(${path}) failed: ${msg(err)}`);
  }
}

/** /proc/meminfo — the swap/mem plane of the escalation thresholds. Only
 *  Linux carries it; anywhere else the line prints unavailable. */
function readMemory(): WatchdogMemory | Unavailable {
  const text = readText('/proc/meminfo');
  if (text === null) {
    return unavailable('no /proc/meminfo (not Linux?)');
  }
  const parsed = parseMeminfo(text);
  if (parsed === null) {
    return unavailable('meminfo missing or malformed SwapTotal/SwapFree/MemAvailable');
  }
  return parsed;
}

/** The three keys the escalation thresholds read, or null the moment one
 *  is missing or malformed — a value that is not `<integer> kB` is not a
 *  measurement (an empty value would otherwise read as a legitimate
 *  zero). Plain string parsing, never a constructed RegExp: a non-literal
 *  pattern is a security finding on every static engine (Codacy's
 *  critical on this PR). */
export function parseMeminfo(text: string): WatchdogMemory | null {
  const kb = (key: string): number | null => {
    const prefix = `${key}:`;
    const line = text.split('\n').find(l => l.startsWith(prefix));
    if (line === undefined) {
      return null;
    }
    const parts = line.slice(prefix.length).trim().split(/\s+/);
    const digits = parts[0];
    const unit = parts[1];
    if (digits === undefined || unit !== 'kB') {
      return null;
    }
    if (!/^[0-9]+$/.test(digits)) {
      return null;
    }
    return Number(digits) * 1024;
  };
  const swapTotal = kb('SwapTotal');
  if (swapTotal === null) {
    return null;
  }
  const swapFree = kb('SwapFree');
  if (swapFree === null) {
    return null;
  }
  const avail = kb('MemAvailable');
  if (avail === null) {
    return null;
  }
  return { swapUsedBytes: Math.max(0, swapTotal - swapFree), memAvailableBytes: avail };
}

function readWorktrees(dir: string): WatchdogWorktrees | Unavailable {
  const r = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) {
    const why = firstLine(r.err) || `exit ${r.code}`;
    return unavailable(`git worktree list failed: ${why}`);
  }
  const count = r.out.split('\n').filter(l => l.startsWith('worktree ')).length;
  return { count };
}

/** daemon.log's age and ETIMEDOUT baseline — read apart from the record
 *  so each side stays under the complexity ceiling. */
function readLogFacts(
  path: string | null,
  exists: boolean,
  now: number
): { logAgeSec: number | null; etimedout: number | null } {
  if (path === null || !exists) {
    return { logAgeSec: null, etimedout: null };
  }
  let logAge: number | null = null;
  try {
    logAge = ageSec(statSync(path).mtimeMs, now);
  } catch {
    logAge = null;
  }
  const stats = scanLogFile(path);
  return { logAgeSec: logAge, etimedout: stats === null ? null : stats.etimedout };
}
/** The daemon plane: `daemon.json`'s armer (alive?) plus daemon.log's age
 *  and ETIMEDOUT baseline. `daemonLogPath` names where the log WOULD be —
 *  only an existing log (or a record) carries facts, so a box with neither
 *  degrades instead of reporting a row of nulls. Liveness pairs the pid
 *  with the record's `/proc` start time: a bare pid check lets a recycled
 *  pid impersonate the daemon (cubic P1). */
function readDaemon(dir: string, now: number): WatchdogDaemon | Unavailable {
  const rec = readDaemonRecord(dir);
  const logPath = daemonLogPath(dir);
  const logExists = logPath !== null && existsSync(logPath);
  if (rec === null && !logExists) {
    return unavailable('no daemon record and no daemon.log');
  }
  const facts = readLogFacts(logPath, logExists, now);
  return {
    pid: rec?.pid ?? null,
    alive: rec === null ? null : pidAlive(rec.pid, rec.pidStart),
    ...facts,
  };
}

function readLoopOut(dir: string, now: number): WatchdogLog | Unavailable {
  const common = gitCommonDir(dir);
  if (common === null) {
    return unavailable('no git common dir');
  }
  const path = join(common, 'bro', 'loop.out');
  const stats = scanLogFile(path);
  if (stats === null) {
    return unavailable('loop.out unreadable or absent');
  }
  let ageSec_: number | null = null;
  try {
    ageSec_ = ageSec(statSync(path).mtimeMs, now);
  } catch {
    ageSec_ = null;
  }
  return { lines: stats.lines, etimedout: stats.etimedout, ageSec: ageSec_ };
}

/** In-flight vs residue — the slot filter, pure so the phantom-worker
 *  rule is testable without a live unit. A record is in flight only when
 *  its pid is alive AND is not the loop's own MainPID: a run record
 *  stamped with the supervisor's pid (one that never settled) would
 *  otherwise read as a phantom worker and send an orchestrator chasing
 *  ghosts. With the unit degraded (`mainPid` null) the filter cannot
 *  distinguish and keeps its honest silence — records report as they are. */
export function splitSlots(
  runs: readonly LoopRunView[],
  mainPid: number | null
): { slots: LoopRunView[]; residue: number } {
  const slots = runs.filter(r => r.state === 'running' && !(mainPid !== null && r.pid === mainPid));
  return { slots, residue: runs.length - slots.length };
}

/** Every baseline, measured now. `now` is injectable so tests pin the
 *  clock; everything else is a plain read. The slots plane degrades in
 *  three steps: no git common dir → unavailable; no records directory
 *  yet → an honest empty (nothing has ever run); a directory that
 *  exists but cannot be read → unavailable (unreadable ≠ none). */
export function collectBaselines(dir: string, now: number = Date.now()): WatchdogBaselines {
  const unit = readUnit();
  const mainPid = isUnavailable(unit) ? null : unit.mainPid;
  const runs = loopRunsDir(dir);
  let slotsPlane: WatchdogSlot[] | Unavailable;
  let residue = 0;
  if (runs === null) {
    slotsPlane = unavailable('no git common dir');
  } else if (!existsSync(runs)) {
    slotsPlane = [];
  } else {
    try {
      readdirSync(runs);
      const split = splitSlots(collectLoopRuns(dir, now), mainPid);
      slotsPlane = split.slots.map(r => ({
        slug: r.slug,
        beadId: r.beadId,
        pid: r.pid,
        state: r.state,
        silentMs: r.silentMs,
      }));
      residue = split.residue;
    } catch {
      slotsPlane = unavailable('bro/loop unreadable');
    }
  }
  return {
    ts: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    unit,
    daemon: readDaemon(dir, now),
    loopOut: readLoopOut(dir, now),
    prs: readPrs(dir),
    disk: readDisk(),
    memory: readMemory(),
    worktrees: readWorktrees(dir),
    slots: slotsPlane,
    residue,
  };
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)}G`;

const secs = (n: number): string => (n >= 90 ? `${Math.round(n / 60)}m` : `${n}s`);

const un = (v: Unavailable): string => `unavailable (${v.unavailable})`;

/** Per-plane formatters — each one plane, each one shallow, so the brief's
 *  render is a flat join instead of a ternary pyramid (the complexity
 *  budget is a review gate, not a suggestion). `unavailable (…)` is what a
 *  probe that could not measure prints; nothing here invents a value. */
const formatUnit = (v: WatchdogUnit | Unavailable): string =>
  isUnavailable(v)
    ? un(v)
    : `${v.state} MainPID=${v.mainPid ?? '?'} NRestarts=${v.nRestarts ?? '?'}`;

const describeLiveness = (alive: boolean | null): string => {
  if (alive === null) {
    return 'unknown';
  }
  return alive ? 'alive' : 'DEAD';
};

const formatDaemon = (v: WatchdogDaemon | Unavailable): string => {
  if (isUnavailable(v)) {
    return un(v);
  }
  const head = v.pid === null ? 'no record' : `pid ${v.pid} ${describeLiveness(v.alive)}`;
  const facts = [
    v.logAgeSec === null ? 'log n/a' : `log age ${secs(v.logAgeSec)}`,
    v.etimedout === null ? '' : `ETIMEDOUT ${v.etimedout}`,
  ].filter(s => s !== '');
  return [head, ...facts].join(' · ');
};

const formatLog = (v: WatchdogLog | Unavailable): string => {
  if (isUnavailable(v)) {
    return un(v);
  }
  const facts = [
    `${v.lines} lines`,
    v.ageSec === null ? '' : `age ${secs(v.ageSec)}`,
    v.etimedout === null ? '' : `ETIMEDOUT ${v.etimedout}`,
  ].filter(s => s !== '');
  return facts.join(' · ');
};

const formatPrs = (v: WatchdogPrs | Unavailable): string =>
  isUnavailable(v) ? un(v) : `${v.open} open · ours ${v.ours} · foreign ${v.foreign}`;

const formatDisk = (v: WatchdogDisk | Unavailable): string =>
  isUnavailable(v) ? un(v) : `${v.path} ${v.usePercent}%`;

const formatMemory = (v: WatchdogMemory | Unavailable): string =>
  isUnavailable(v)
    ? un(v)
    : `swap used ${gib(v.swapUsedBytes)} · avail ${gib(v.memAvailableBytes)}`;

const formatWorktrees = (v: WatchdogWorktrees | Unavailable): string =>
  isUnavailable(v) ? un(v) : String(v.count);

const formatSlots = (slots: WatchdogSlot[] | Unavailable): string => {
  if (isUnavailable(slots)) {
    return un(slots);
  }
  if (slots.length === 0) {
    return 'none in flight';
  }
  const shown = slots
    .slice(0, 4)
    .map(s => `${s.slug} pid=${s.pid ?? '-'} ${s.state}`)
    .join(' · ');
  const more = slots.length > 4 ? ' …' : '';
  return `${slots.length} — ${shown}${more}`;
};

/** The brief — also the prompt `/bro` feeds back into the session, so the
 *  launch steps are imperative and the facts are labelled as measurements. */
export function renderWatchdogBrief(b: WatchdogBaselines): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(10)} ${value}`;
  const residue =
    b.residue > 0
      ? row(
          'residue',
          `${b.residue} loop/ record(s) not in flight (dead pid or stamped with the loop's own pid)`
        )
      : null;

  return [
    'watchdog — infinite read-only orchestration loop over the bro pipeline',
    '',
    'Launch:',
    `  1. Load the \`${WATCHDOG_SKILL}\` skill (skill tool) — it holds the tick`,
    '     protocol: one background tick at a time, READ-ONLY, the next tick',
    '     chained only after the previous closes with a WAKE|TIMEOUT verdict.',
    '  2. Adopt the baselines below as tick 0 — measured now, never remembered.',
    '  3. Spawn tick 1; report WAKE events to the operator, keep the chain alive.',
    '',
    `baselines @ ${b.ts}`,
    row('unit', formatUnit(b.unit)),
    row('daemon', formatDaemon(b.daemon)),
    row('loop.out', formatLog(b.loopOut)),
    row('prs', formatPrs(b.prs)),
    row('disk', formatDisk(b.disk)),
    row('memory', formatMemory(b.memory)),
    row('worktrees', formatWorktrees(b.worktrees)),
    row('slots', formatSlots(b.slots)),
    ...(residue === null ? [] : [residue]),
    '',
  ].join('\n');
}

export function runWatchdogCommand(argv: string[]): void {
  if (hasHelpFlag(argv)) {
    printUsage('usage: bro watchdog [--json]', 0);
  }
  // strict like `bro notify` — an unknown flag is a typo, never silently
  // ignored input on a command whose whole job is honest measurement
  const unknown = argv.filter(a => a !== '--json');
  if (unknown.length > 0) {
    console.error(`usage: bro watchdog [--json] (unknown: ${unknown.join(' ')})`);
    process.exit(2);
  }
  const baselines = collectBaselines(process.cwd());
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ts: baselines.ts, skill: WATCHDOG_SKILL, baselines }, null, 2));
    return;
  }
  console.log(renderWatchdogBrief(baselines));
}
