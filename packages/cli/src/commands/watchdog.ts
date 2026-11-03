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
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir, gitTry, ghTry, hasHelpFlag, pidAlive, printUsage } from '@broject/core';
import { collectLoopRuns, type LoopRunView } from './loop-state.ts';
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
   *  are, are residue of a run that never settled). [] = none in flight. */
  slots: WatchdogSlot[];
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

/** wc -l / grep -n semantics computed in JS — the same numbers a tick's
 *  shell probes produce, so brief and tick never quote divergent baselines.
 *  The line number of the last ETIMEDOUT is the sticky escalation baseline:
 *  a fresh line ABOVE it is what a tick reports. Exported for tests — this
 *  is the arithmetic the whole escalation plane rests on. */
export function logStats(text: string): { lines: number; etimedout: number | null } {
  const lines = text.split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  const count = endsWithNewline ? lines.length - 1 : lines.length;
  let etimedout: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.includes('ETIMEDOUT')) {
      etimedout = i + 1;
      break;
    }
  }
  return { lines: count, etimedout };
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** `systemctl --user show bro-loop` — the unit row a tick quotes. Any
 *  spawn failure, timeout or missing key degrades: a box with no systemd
 *  user instance is not a broken watchdog. */
function readUnit(): WatchdogUnit | Unavailable {
  let stdout: string | null = null;
  try {
    const r = spawnSync(
      'systemctl',
      ['--user', 'show', UNIT, '-p', 'ActiveState,MainPID,NRestarts'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (r.error === undefined && r.status === 0 && r.stdout) {
      stdout = r.stdout;
    }
  } catch {
    stdout = null;
  }
  if (stdout === null) {
    return unavailable('systemctl unavailable');
  }
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

/** `gh pr list --state open --limit 100 --json …` — the PR-count baseline
 *  (a drop = auto-merge event, a rise = new PR). Non-zero gh or unreadable
 *  JSON degrades rather than lying with a zero. */
function readPrs(dir: string): WatchdogPrs | Unavailable {
  const r = ghTry(
    ['pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT), '--json', 'number,headRefName'],
    dir
  );
  if (r.code !== 0) {
    return unavailable(`gh pr list failed: ${firstLine(r.err) || `exit ${r.code}`}`);
  }
  try {
    const rows = JSON.parse(r.out) as Array<{ number?: number; headRefName?: string }>;
    if (!Array.isArray(rows)) {
      return unavailable('gh pr list returned a non-array');
    }
    const ours = rows.filter(p => OURS.test(p.headRefName ?? '')).length;
    return { open: rows.length, ours, foreign: rows.length - ours };
  } catch (err) {
    return unavailable(`gh pr list unreadable: ${msg(err)}`);
  }
}

/** statfs over the watched tmpfs — `df`'s Use% in one syscall. Non-POSIX
 *  or a vanished mount degrades. */
function readDisk(path: string = DISK_PATH): WatchdogDisk | Unavailable {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize;
    if (!(total > 0)) {
      return unavailable(`statfs(${path}) reports an empty filesystem`);
    }
    const used = total - s.bfree * s.bsize;
    return { path, usePercent: Math.round((used / total) * 100) };
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
  const kb = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m && m[1] !== undefined ? Number(m[1]) * 1024 : null;
  };
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  const avail = kb('MemAvailable');
  if (swapTotal === null || swapFree === null || avail === null) {
    return unavailable('meminfo missing SwapTotal/SwapFree/MemAvailable');
  }
  return { swapUsedBytes: Math.max(0, swapTotal - swapFree), memAvailableBytes: avail };
}

function readWorktrees(dir: string): WatchdogWorktrees | Unavailable {
  const r = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) {
    return unavailable(`git worktree list failed: ${firstLine(r.err) || `exit ${r.code}`}`);
  }
  const count = r.out.split('\n').filter(l => l.startsWith('worktree ')).length;
  return { count };
}

/** The daemon plane: `daemon.json`'s armer (alive?) plus daemon.log's age
 *  and ETIMEDOUT baseline. `daemonLogPath` names where the log WOULD be —
 *  only an existing log (or a record) carries facts, so a box with neither
 *  degrades instead of reporting a row of nulls. */
function readDaemon(dir: string, now: number): WatchdogDaemon | Unavailable {
  const rec = readDaemonRecord(dir);
  const logPath = daemonLogPath(dir);
  const logExists = logPath !== null && existsSync(logPath);
  if (rec === null && !logExists) {
    return unavailable('no daemon record and no daemon.log');
  }
  let logAgeSec: number | null = null;
  let etimedout: number | null = null;
  if (logPath !== null && logExists) {
    try {
      logAgeSec = ageSec(statSync(logPath).mtimeMs, now);
    } catch {
      logAgeSec = null;
    }
    const text = readText(logPath);
    if (text !== null) {
      etimedout = logStats(text).etimedout;
    }
  }
  return {
    pid: rec?.pid ?? null,
    alive: rec === null ? null : pidAlive(rec.pid),
    logAgeSec,
    etimedout,
  };
}

function readLoopOut(dir: string, now: number): WatchdogLog | Unavailable {
  const common = gitCommonDir(dir);
  if (common === null) {
    return unavailable('no git common dir');
  }
  const path = join(common, 'bro', 'loop.out');
  const text = readText(path);
  if (text === null) {
    return unavailable('loop.out unreadable or absent');
  }
  let ageSec_: number | null = null;
  try {
    ageSec_ = ageSec(statSync(path).mtimeMs, now);
  } catch {
    ageSec_ = null;
  }
  return { ...logStats(text), ageSec: ageSec_ };
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
 *  clock; everything else is a plain read. */
export function collectBaselines(dir: string, now: number = Date.now()): WatchdogBaselines {
  const unit = readUnit();
  const mainPid = isUnavailable(unit) ? null : unit.mainPid;
  const { slots, residue } = splitSlots(collectLoopRuns(dir, now), mainPid);
  return {
    ts: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    unit,
    daemon: readDaemon(dir, now),
    loopOut: readLoopOut(dir, now),
    prs: readPrs(dir),
    disk: readDisk(),
    memory: readMemory(),
    worktrees: readWorktrees(dir),
    slots: slots.map(r => ({
      slug: r.slug,
      beadId: r.beadId,
      pid: r.pid,
      state: r.state,
      silentMs: r.silentMs,
    })),
    residue,
  };
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)}G`;

const secs = (n: number): string => (n >= 90 ? `${Math.round(n / 60)}m` : `${n}s`);

const un = (v: Unavailable): string => `unavailable (${v.unavailable})`;

/** The brief — also the prompt `/bro` feeds back into the session, so the
 *  launch steps are imperative and the facts are labelled as measurements. */
export function renderWatchdogBrief(b: WatchdogBaselines): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(10)} ${value}`;

  const unit = isUnavailable(b.unit)
    ? un(b.unit)
    : `${b.unit.state} MainPID=${b.unit.mainPid ?? '?'} NRestarts=${b.unit.nRestarts ?? '?'}`;
  const daemon = isUnavailable(b.daemon)
    ? un(b.daemon)
    : [
        b.daemon.pid === null
          ? 'no record'
          : `pid ${b.daemon.pid} ${b.daemon.alive ? 'alive' : 'DEAD'}`,
        b.daemon.logAgeSec === null ? 'log n/a' : `log age ${secs(b.daemon.logAgeSec)}`,
        b.daemon.etimedout === null ? '' : `ETIMEDOUT ${b.daemon.etimedout}`,
      ]
        .filter(s => s !== '')
        .join(' · ');
  const loopOut = isUnavailable(b.loopOut)
    ? un(b.loopOut)
    : [
        `${b.loopOut.lines} lines`,
        b.loopOut.ageSec === null ? '' : `age ${secs(b.loopOut.ageSec)}`,
        b.loopOut.etimedout === null ? '' : `ETIMEDOUT ${b.loopOut.etimedout}`,
      ]
        .filter(s => s !== '')
        .join(' · ');
  const prs = isUnavailable(b.prs)
    ? un(b.prs)
    : `${b.prs.open} open · ours ${b.prs.ours} · foreign ${b.prs.foreign}`;
  const disk = isUnavailable(b.disk) ? un(b.disk) : `${b.disk.path} ${b.disk.usePercent}%`;
  const memory = isUnavailable(b.memory)
    ? un(b.memory)
    : `swap used ${gib(b.memory.swapUsedBytes)} · avail ${gib(b.memory.memAvailableBytes)}`;
  const worktrees = isUnavailable(b.worktrees) ? un(b.worktrees) : String(b.worktrees.count);
  const slots =
    b.slots.length === 0
      ? 'none in flight'
      : `${b.slots.length} — ${b.slots
          .slice(0, 4)
          .map(s => `${s.slug} pid=${s.pid ?? '-'} ${s.state}`)
          .join(' · ')}${b.slots.length > 4 ? ' …' : ''}`;
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
    row('unit', unit),
    row('daemon', daemon),
    row('loop.out', loopOut),
    row('prs', prs),
    row('disk', disk),
    row('memory', memory),
    row('worktrees', worktrees),
    row('slots', slots),
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
