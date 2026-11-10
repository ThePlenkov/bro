/**
 * `bro daemon` — the project-scoped supervisor's lifecycle. The daemon
 * is a long-lived userspace process (dockerd/containerd shape — you
 * start it, you kill it, nothing persists it at boot) that owns the
 * drive pass: act gates, fixer spawns, merges. `bro serve` is the UI
 * surface, `bro watch` the bounded observer; the daemon is the third
 * role — the owner (spec bro-ybrja, naming in bro-oy3k1).
 *
 * v1 is deliberately thin: `daemon run` IS `bro drive --every` — the
 * existing supervisor loop with its own guard, one-per-repo
 * `drive.lock` hold, and heartbeat emission. `up` spawns that loop
 * detached and records the armer in `daemon.json`; `status`/`down`
 * read the lock. Agents stay detached registry peers — the daemon
 * owns their scheduling, never their parentage.
 *
 * The persistent form (bro-y5zon, spec specs/bro-y5zon.md):
 * `bro drive install` writes `<git-common>/bro/drive.json` — the
 * want-marker, `pulse.json`'s merge-path analogue — and brings the
 * supervisor up; the `driveConnector` checkpoint (sessionStart +
 * postTool, orchestrator-only) rearms a dead supervisor from it.
 * `daemon down` under an install is a transient stop — the next
 * checkpoint brings it back; `bro drive uninstall` is the disarm.
 *
 * Loop installs mirror drive: `bro loop install` writes
 * `<git-common>/bro/loop.json` and brings a supervised `bro loop` up;
 * `daemon run --loop` runs it, and the rearm checkpoints can revive it.
 */
import {
  execFileSync,
  spawn,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  acquireFileLock,
  gitCommonDir,
  lockHolderPid,
  pidAlive,
  hasHelpFlag,
  printUsage,
  procStat,
  staleLock,
} from '@broject/core';
import type { ExitCode } from '@broject/core';
import { flag } from './args.ts';
import { driveLockPath, runDriveCommand } from './drive.ts';
import { runLoopCommand } from './loop.ts';
import { driveSection, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts';
import { SELF_ENTRY } from './self-entry.ts';
import { readWantMarker } from './want-marker.ts';
import { isOrchestratorSession } from './watch-pulse.ts';
import { mainWorktree } from './work.ts';
import { loadBroConfig } from '../plugins.ts';
import { loopSection } from '@broject/loop';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    'Usage: bro daemon <up|status|down|run> [--every SEC] [--loop]\n' +
      '  up      spawn the detached supervisor (orchestrator sessions only)\n' +
      '  status  supervisor liveness — lock holder, armer record, log path\n' +
      '  down    SIGTERM the supervisor and clear the armer record\n' +
      '  run     the supervised loop itself — spawned by `up`, not for direct use',
    exitCode
  );
}

export interface DaemonRecord {
  pid: number;
  everySec: number;
  spawnedAt: string;
  cmd: string;
  /** the child's /proc start time — pins the pid against reuse; absent
   *  on older records, which the probe never trusts (a bare pid cannot
   *  be told from a recycled one) */
  pidStart?: string;
}

/** Records written by older binaries lack `pidStart` — they are never
 *  trusted: a record's only job is the pre-lock window of a NEW spawn,
 *  and new records always carry the pin. Trusting a bare pid would let
 *  a recycled one take SIGTERM meant for a dead supervisor. */

/** `<git-common>/bro/daemon.json` — who armed the daemon
 *  (`daemon-loop.json` for the loop kind: each supervisor kind keeps
 *  its own record so a both-installed repo's later spawn cannot
 *  clobber the first's pre-lock cover). Written by `up`, removed by
 *  `down`; distinct from the kind's own lock, which is the
 *  supervisor's liveness hold. A record without a live holder is the
 *  watchdog's "daemon died" signal. */
export function daemonStatePath(dir: string, opts: { loop?: boolean } = {}): string | null {
  const common = gitCommonDir(dir);
  const file = opts.loop === true ? 'daemon-loop.json' : 'daemon.json';
  return common === null ? null : join(common, 'bro', file);
}

export function daemonLogPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'daemon.log');
}

export function readDaemonRecord(dir: string, opts: { loop?: boolean } = {}): DaemonRecord | null {
  const file = daemonStatePath(dir, opts);
  if (file === null || !existsSync(file)) {
    return null;
  }
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<DaemonRecord>;
    return typeof rec.pid === 'number' && typeof rec.everySec === 'number'
      ? {
          pid: rec.pid,
          everySec: rec.everySec,
          spawnedAt: rec.spawnedAt ?? '',
          cmd: rec.cmd ?? '',
          pidStart: typeof rec.pidStart === 'string' ? rec.pidStart : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

function writeDaemonRecord(dir: string, rec: DaemonRecord, opts: { loop?: boolean } = {}): void {
  const file = daemonStatePath(dir, opts);
  if (file === null) {
    return;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, file);
}

/** `<git-common>/bro/loop.lock` — the loop supervisor's liveness hold,
 *  `drive.lock`'s loop-kind twin: held for the whole `bro loop --every`
 *  run, reaped by the same janitor when its holder dies. */
export function loopLockPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'loop.lock');
}

export interface SupervisorProbe {
  live: boolean;
  pid?: number;
  recorded: DaemonRecord | null;
}

/** The probe every supervisor kind shares: the kind's own lock is the
 *  liveness truth, its own spawn record covers the pre-lock window.
 *  `staleLock` bounds the holder check the way a contender's steal
 *  does: `pidAlive` alone is reuse-blind (the token is `pid:hex`, no
 *  start time), so a hold whose heartbeat aged past the abandoned
 *  bound doesn't count even while its pid lives — a recycled pid
 *  masks a dead supervisor for one window at most, never forever. */
function probeSupervisor(
  dir: string,
  lock: string | null,
  recorded: DaemonRecord | null
): SupervisorProbe {
  const lockLive = lock !== null && existsSync(lock) && !staleLock(lock);
  const lockPid = lockLive ? lockHolderPid(lock) : null;
  if (lockPid !== null && pidAlive(lockPid)) {
    return { live: true, pid: lockPid, recorded };
  }
  if (recorded !== null && recordedPidAlive(recorded)) {
    return { live: true, pid: recorded.pid, recorded };
  }
  return { live: false, recorded };
}

/** The drive kind's probe — the `drive.lock` holder when alive, else a
 *  still-alive recorded armer (child spawned, not yet holding). */
export function daemonProbe(dir: string): SupervisorProbe {
  return probeSupervisor(dir, driveLockPath(dir), readDaemonRecord(dir));
}

/** The loop kind's probe — `loop.lock` + `daemon-loop.json`. A live
 *  drive supervisor must never mask a dead loop (and vice versa):
 *  each want-marker rearms against its own plane or a both-installed
 *  repo revives only half of what it armed. */
export function loopProbe(dir: string): SupervisorProbe {
  return probeSupervisor(dir, loopLockPath(dir), readDaemonRecord(dir, { loop: true }));
}

/** How long an UNPINNED record may stand in for the pre-lock window —
 *  a fresh spawn's pid cannot have been recycled seconds after minting.
 *  Past it, the record is trusted only with its start-time pin. */
const UNPINNED_RECORD_GRACE_MS = 120_000;

/** A recorded pid is trusted only with its stored start time; records
 *  that predate the field cannot be verified against reuse and must
 *  never be trusted to supervise or kill processes. One exception: on a
 *  host where /proc cannot produce a start time at all (procStat fails
 *  for our own pid — no procfs, macOS, a restricted container), a NEW
 *  record still cannot carry the pin — yet the pid it names was minted
 *  seconds ago, so reuse has had no window. Those records are trusted
 *  for the spawn grace only; an old record on a /proc-capable host is
 *  never trusted unpinned. */
function recordedPidAlive(rec: DaemonRecord): boolean {
  if (rec.pidStart !== undefined) {
    return pidAlive(rec.pid, rec.pidStart);
  }
  if (procStat(process.pid) !== null) {
    return false;
  }
  const age = Date.now() - Date.parse(rec.spawnedAt);
  return Number.isFinite(age) && age >= 0 && age <= UNPINNED_RECORD_GRACE_MS && pidAlive(rec.pid);
}

export type DaemonUpDecision =
  | { kind: 'refuse-worker' }
  | { kind: 'already'; pid: number }
  | { kind: 'spawn' };

/** `up` is idempotent: a live supervisor (daemon-spawned or a raw
 *  `bro drive --every`) reports rather than doubles; workers pin
 *  BRO_AGENT_ID and never arm one. */
export function daemonUpDecision(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { loop?: boolean } = {}
): DaemonUpDecision {
  if (!isOrchestratorSession(env)) {
    return { kind: 'refuse-worker' };
  }
  const probe = opts.loop === true ? loopProbe(dir) : daemonProbe(dir);
  return probe.live ? { kind: 'already', pid: probe.pid! } : { kind: 'spawn' };
}

/** `<git-common>/bro/daemon.up.lock` — serializes the up path's
 *  decide→spawn→record sequence; concurrent `up` calls otherwise both
 *  see no live holder and both spawn (the child's own drive.lock makes
 *  the second a standby, but two spawns is still a lie about "never
 *  doubles"). */
export function daemonUpLockPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'daemon.up.lock');
}

/** Spawn the supervisor loop detached — same fire-and-forget shape as
 *  the pulse rearm: own process group, parent-unref'd, SELF_ENTRY so
 *  dist and source installs both re-spawn themselves. Unlike the pulse the
 *  daemon gets a real log — an owner must be debuggable. The record is
 *  best-effort: `drive.lock` is the liveness truth, `daemon.json` only
 *  says who armed it — a failed write warns, never orphans the report. */
export function spawnDaemon(
  dir: string,
  everySec: number,
  opts: { loop?: boolean } = {}
): { pid: number; log: string | null } {
  const log = daemonLogPath(dir);
  const broDir = daemonStatePath(dir);
  if (broDir !== null) {
    mkdirSync(join(broDir, '..'), { recursive: true });
  }
  const out = log === null ? 'ignore' : openSync(log, 'a');
  const args = opts.loop
    ? [SELF_ENTRY!, 'daemon', 'run', '--loop', '--every', String(everySec)]
    : [SELF_ENTRY!, 'daemon', 'run', '--every', String(everySec)];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', out, out],
    // stamp every daemon-log line — BRO_LOG_TIMESTAMP is read only by
    // logWithTs/errWithTs and the TTY/json-guarded index patch, so a
    // worker that inherits it never gets timestamped machine output
    env: { ...process.env, BRO_LOG_TIMESTAMP: '1' },
  });
  child.unref();
  try {
    writeDaemonRecord(
      dir,
      {
        pid: child.pid!,
        everySec,
        spawnedAt: new Date().toISOString(),
        cmd: opts.loop
          ? `bro daemon run --loop --every ${everySec}`
          : `bro daemon run --every ${everySec}`,
        pidStart: procStat(child.pid!)?.start,
      },
      opts
    );
  } catch (err) {
    // an unrecorded child is an unsupervised supervisor — kill it and
    // fail, never leave a daemon nobody can see
    try {
      child.kill('SIGTERM');
    } catch {
      // exited before the write failed — nothing to clean
    }
    throw err;
  }
  return { pid: child.pid!, log };
}

/** Every supervision-loop process OWNED BY THIS REPO — `daemon run
 *  --every` children plus raw `bro drive --every`/`bro loop --every` runs (they hold the
 *  same lock, so `down` owes them the same SIGTERM or a standby
 *  quietly inherits it). The pgrep match is machine-wide, so each hit
 *  is re-scoped by repo: the candidate's /proc cwd must resolve to the
 *  same git common dir as `dir` — a raw drive started in a linked
 *  worktree resolves to it, a supervisor serving another repo (the
 *  rig's own daemon included) never does. A candidate whose ownership
 *  can't be verified — no /proc, cwd raced away, outside any repo —
 *  is spared: the sweep errs toward missing a standby, never toward
 *  killing a stranger. */
function supervisionProcs(dir: string, kind?: 'drive' | 'loop'): number[] {
  const common = gitCommonDir(dir);
  if (common === null) {
    return [];
  }
  let pids: number[];
  try {
    // pgrep is a required runtime dep; the options pin PATH to fixed
    // unwriteable dirs — the default inherited PATH can contain
    // user-writable dirs (sonar S4036). The call stays one line so the
    // NOSONAR survives biome reformatting.
    // one alternation per kind — `daemon run --loop --every` carries the
    // `loop --every` pair inside it, so the loop pattern alone covers
    // spawned and raw loop supervisors; the drive side needs its two
    // shapes spelled out
    const pattern =
      kind === 'loop'
        ? 'loop --every'
        : kind === 'drive'
          ? '(daemon run|drive) --every'
          : '(daemon run|drive|loop) --every';
    const pgrepArgs = ['-f', pattern];
    const pgrepOpts: ExecFileSyncOptionsWithStringEncoding = {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin' },
    };
    const out = execFileSync('pgrep', pgrepArgs, pgrepOpts); // NOSONAR
    pids = out
      .split('\n')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
  return pids.filter(pid => {
    const owned = procRepoCommon(pid);
    return owned !== null && sameDir(owned, common);
  });
}

/** The git common dir of the repo a process runs in — /proc cwd first,
 *  then git names the repo. null when either step can't answer: an
 *  unverifiable candidate is spared, never killed. */
function procRepoCommon(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return gitCommonDir(readlinkSync(`/proc/${pid}/cwd`));
    }
    if (process.platform === 'darwin') {
      try {
        const out = execFileSync(
          'lsof', // NOSONAR — PATH lookup is the contract
          ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          {
            encoding: 'utf8',
            timeout: 500,
          }
        );
        const cline = out.split('\n').find(l => l.startsWith('n'));
        if (cline) {
          const cwd = cline.slice(1);
          return gitCommonDir(cwd);
        }
      } catch {
        // fall through
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Path equality that survives symlink spellings — worktree paths and
 *  /proc targets may spell the same directory differently. */
function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

function everyArg(argv: string[], fallback: number): number {
  const raw = flag(argv, '--every');
  if (raw === undefined) {
    return fallback;
  }
  const everySec = Number(raw);
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs seconds ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}, got "${raw}"`
    );
    process.exit(2);
  }
  return everySec;
}

export type SupervisorUp =
  | { kind: 'spawned'; pid: number; log: string | null }
  | { kind: 'already'; pid: number }
  | { kind: 'disarmed' }
  | { kind: 'refuse-worker' };

/** The up path's decide→spawn→record sequence — `daemon up`'s core,
 *  extracted so `drive install` and the rearm checkpoint run the same
 *  steps under the same `daemon.up.lock`: a concurrent armer collapses
 *  to 'already' instead of doubling. `requireMarker` is the rearm-side
 *  race fix: the checkpoint read the marker BEFORE this lock, so the
 *  want is re-checked inside it — an uninstall that disarmed while the
 *  spawn waited must not resurrect a supervisor. */
export function supervisorUp(
  dir: string,
  everySec: number,
  env: NodeJS.ProcessEnv = process.env,
  opts: { requireMarker?: boolean; loop?: boolean } = {}
): SupervisorUp {
  const upLock = daemonUpLockPath(dir);
  const release = upLock === null ? () => {} : acquireFileLock(upLock, { label: 'daemon up lock' });
  try {
    const decision = daemonUpDecision(dir, env, { loop: opts.loop });
    if (decision.kind === 'refuse-worker') {
      return { kind: 'refuse-worker' };
    }
    if (decision.kind === 'already') {
      return { kind: 'already', pid: decision.pid };
    }
    if (opts.requireMarker === true) {
      if (opts.loop) {
        if (readLoopMarker(dir) === null) {
          return { kind: 'disarmed' };
        }
      } else if (readDriveMarker(dir) === null) {
        return { kind: 'disarmed' };
      }
    }
    const spawned = spawnDaemon(dir, everySec, { loop: opts.loop });
    return { kind: 'spawned', pid: spawned.pid, log: spawned.log };
  } finally {
    release();
  }
}

export interface SupervisorDown {
  /** pids SIGTERM was sent to — holder, live record, every standby. */
  pids: number[];
  /** daemon.json existed and was removed. */
  hadRecord: boolean;
}

/** The down path — SIGTERM the holder plus every supervision loop that
 *  could inherit its lock (standbys wait on the kind's lock), then clear
 *  the armer record. `daemon down` sweeps every kind; `drive|loop
 *  uninstall` scopes the sweep to its own plane so a sibling's
 *  supervision survives — a repo with both installed never loses the
 *  one it didn't uninstall. */
export function supervisorDown(
  dir: string,
  opts: { kind?: 'drive' | 'loop' } = {}
): SupervisorDown {
  const kinds = opts.kind === undefined ? (['drive', 'loop'] as const) : [opts.kind];
  /** One kind's victims — its lock holder, its still-live recorded pid,
   *  and every repo-scoped standby that could inherit the lock. */
  const victimsOf = (kind: 'drive' | 'loop'): number[] => {
    const probe = kind === 'loop' ? loopProbe(dir) : daemonProbe(dir);
    // live-but-pidless probes exist (e.g. a lock held by an
    // unresolvable holder) — a bare `!` would push undefined into the
    // kill list and count a TypeError as "already gone"
    const pids = probe.live && probe.pid !== undefined ? [probe.pid] : [];
    if (
      probe.recorded !== null &&
      probe.recorded.pidStart !== undefined &&
      pidAlive(probe.recorded.pid, probe.recorded.pidStart)
    ) {
      pids.push(probe.recorded.pid);
    }
    return [...pids, ...supervisionProcs(dir, kind)];
  };
  const victims = new Set<number>(kinds.flatMap(victimsOf));
  victims.delete(process.pid);
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone — SIGTERM is advisory, absence is not a failure
    }
  }
  // the sweep clears only its own kinds' armer records
  let hadRecord = false;
  for (const kind of kinds) {
    const state = daemonStatePath(dir, { loop: kind === 'loop' });
    if (state !== null) {
      hadRecord = hadRecord || existsSync(state);
      rmSync(state, { force: true });
    }
  }
  return { pids: [...victims], hadRecord };
}

/** The daemon-log voice — a spawned supervisor's stdout is the log
 *  file, so its own lines get the ISO stamp the index patch gives TTY
 *  sessions (BRO_LOG_TIMESTAMP pins which children speak stamped). */
function logWithTs(msg: string): void {
  if (process.env.BRO_LOG_TIMESTAMP === '1') {
    try {
      process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
      return;
    } catch {
      // fall through to the plain write
    }
  }
  console.log(msg);
}
function errWithTs(msg: string): void {
  if (process.env.BRO_LOG_TIMESTAMP === '1') {
    try {
      process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
      return;
    } catch {
      // fall through to the plain write
    }
  }
  console.error(msg);
}

function daemonUp(main: string, interval: number, opts: { loop?: boolean } = {}): void {
  const up = supervisorUp(main, interval, process.env, { loop: opts.loop });
  switch (up.kind) {
    case 'refuse-worker':
      errWithTs(
        'error: BRO_AGENT_ID is set — spawned workers never arm the daemon; ' +
          'the orchestrator session owns it'
      );
      process.exit(2);
    case 'already':
      logWithTs(`daemon up — already supervising (pid ${up.pid})`);
      return;
    case 'spawned':
      logWithTs(
        `daemon up — pid ${up.pid} every ${interval}s` + (up.log === null ? '' : ` — log ${up.log}`)
      );
      return;
  }
}

function daemonStatus(main: string): void {
  const probe = daemonProbe(main);
  const lprobe = loopProbe(main);
  const log = daemonLogPath(main);
  const dmarker = readDriveMarker(main);
  const lmarker = readLoopMarker(main);
  const installed = [];
  if (dmarker !== null) {
    installed.push(`drive installed (every ${dmarker.everySec}s)`);
  }
  if (lmarker !== null) {
    installed.push(`loop installed (every ${lmarker.everySec}s)`);
  }
  const installedStr = installed.length === 0 ? '' : ` · ${installed.join(' · ')}`;
  // per-kind planes — a both-installed repo reports both supervisors
  const live: string[] = [];
  if (probe.live) {
    live.push(lprobe.live ? `pid ${probe.pid} (drive)` : `pid ${probe.pid}`);
  }
  if (lprobe.live) {
    live.push(probe.live ? `pid ${lprobe.pid} (loop)` : `pid ${lprobe.pid}`);
  }
  const recorded = probe.recorded ?? lprobe.recorded;
  if (live.length === 0) {
    logWithTs(
      (recorded === null
        ? `daemon down — no supervisor; 'bro daemon up' to start`
        : `daemon down — recorded pid ${recorded.pid} is dead`) + installedStr
    );
    return;
  }
  logWithTs(
    `daemon up — ${live.join(' · ')} supervising` +
      (recorded === null ? ' (unrecorded holder)' : `, armed ${recorded.spawnedAt}`) +
      installedStr +
      (log === null ? '' : ` — log ${log}`)
  );
}

function daemonDown(main: string): void {
  // serialized with supervisorUp/uninstallDrive on daemon.up.lock: an
  // in-flight spawn must land BEFORE the victim sweep is computed, or
  // down could miss a child not yet visible to probe/supervisionProcs
  const upLock = daemonUpLockPath(main);
  const release = upLock === null ? () => {} : acquireFileLock(upLock, { label: 'daemon up lock' });
  let down: SupervisorDown;
  try {
    down = supervisorDown(main);
  } finally {
    release();
  }
  const { pids } = down;
  const disarms = [
    readDriveMarker(main) !== null ? `'bro drive uninstall'` : null,
    readLoopMarker(main) !== null ? `'bro loop uninstall'` : null,
  ].filter((s): s is string => s !== null);
  logWithTs(
    [
      pids.length === 0
        ? 'daemon down — no live supervisor'
        : `daemon down — signalled ${pids.join(', ')}`,
      // under an install, down is a transient stop — the next session
      // checkpoint rearms from the marker; uninstall is the disarm
      disarms.length === 0
        ? ''
        : `installed — the next session checkpoint rearms it; disarm with ${disarms.join(' or ')}`,
    ]
      .filter(s => s !== '')
      .join('\n  ')
  );
}

// --- the install want-marker (bro-y5zon) --------------------------------------

export interface DriveMarker {
  /** pass cadence the rearmed supervisor runs `--every` at */
  everySec: number;
  armedAt: string;
}

/** `<git-common>/bro/drive.json` — the merge-path want-marker,
 *  `pulse.json`'s analogue: durable intent that survives sessions and
 *  reboots; the connector's checkpoints rearm a dead supervisor from
 *  it. `daemon.json` stays the transient spawn record; `drive.lock`
 *  the liveness hold. */
export function driveMarkerPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'drive.json');
}

/** The want-record — null when absent, malformed, or the repo has no
 *  common dir; readWantMarker owns the torn/cadence verdict. */
export function readDriveMarker(dir: string): DriveMarker | null {
  return readWantMarker(driveMarkerPath(dir));
}

/** The want-marker arm states — armed fresh, re-armed at a new cadence,
 *  or already holding the same cadence. */
export type ArmState = 'armed' | 'updated' | 'already';

/** Write the want-marker (tmp+rename — the mailbox drop rule). Same
 *  cadence is `already` and leaves the file alone; a changed one is
 *  `updated`. */
export function armDrive(dir: string, everySec: number): { state: ArmState; marker: DriveMarker } {
  const file = driveMarkerPath(dir);
  if (file === null) {
    throw new Error('not a git repository — the install marker has no common dir to live in');
  }
  const cur = readDriveMarker(dir);
  if (cur !== null && cur.everySec === everySec) {
    return { state: 'already', marker: cur };
  }
  const marker: DriveMarker = { everySec, armedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2));
  renameSync(tmp, file);
  return { state: cur === null ? 'armed' : 'updated', marker };
}

/** Remove the want-marker. A live supervisor keeps running — disarm
 *  drops the rearm intent; `uninstallDrive` sends the SIGTERM. */
export function disarmDrive(dir: string): 'disarmed' | 'absent' {
  const file = driveMarkerPath(dir);
  if (file === null || !existsSync(file)) {
    return 'absent';
  }
  rmSync(file);
  return 'disarmed';
}

export type DriveRearm = { kind: 'quiet' } | { kind: 'rearm'; everySec: number };

/** The checkpoint decision — armed marker + dead supervisor +
 *  orchestrator → rearm the daemon. Pure: the probe spawns on 'rearm',
 *  everything else stays quiet. `daemonProbe` doubles as the
 *  spawn-record check: `daemon.json` is the pulse.spawn.json analogue —
 *  a live recorded child (pre-lock window, or a standby behind another
 *  contender) suppresses the next rearm; a dead recorded pid does not. */
export function driveRearm(dir: string, env: NodeJS.ProcessEnv = process.env): DriveRearm {
  if (!isOrchestratorSession(env)) {
    return { kind: 'quiet' };
  }
  const marker = readDriveMarker(dir);
  if (marker === null || daemonProbe(dir).live) {
    return { kind: 'quiet' };
  }
  return { kind: 'rearm', everySec: marker.everySec };
}

export interface DriveInstallResult {
  state: 'installed' | 'updated' | 'already' | 'removed' | 'absent' | 'printed' | 'error';
  detail: string;
}

/** Injectable seams for tests — the real verbs spawn and SIGTERM. */
export interface DriveSchedDeps {
  up?: (
    dir: string,
    everySec: number,
    env?: NodeJS.ProcessEnv,
    opts?: { requireMarker?: boolean; loop?: boolean }
  ) => SupervisorUp;
  down?: (dir: string, opts?: { kind?: 'drive' | 'loop' }) => SupervisorDown;
}

/** The loop installer's seams — the same supervisor verbs, loop kind. */
export type LoopSchedDeps = DriveSchedDeps;

/** The install detail's supervisor fragment — one wording for both
 *  install kinds (drive and loop). */
function installSupLine(up: SupervisorUp, everySec: number): string {
  if (up.kind === 'spawned') {
    return `supervisor up — pid ${up.pid} every ${everySec}s`;
  }
  if (up.kind === 'already') {
    return `already supervising (pid ${up.pid})`;
  }
  if (up.kind === 'disarmed') {
    return 'supervisor not spawned — a racing uninstall disarmed it';
  }
  return 'supervisor spawn refused — workers never arm it';
}

/** The arm verb in an install detail — armed / re-armed / already armed. */
function armVerb(state: ArmState): string {
  if (state === 'already') {
    return 'already armed';
  }
  if (state === 'updated') {
    return 're-armed';
  }
  return 'armed';
}

/** `bro drive install` — arm the want-marker, then bring the supervisor
 *  up (enable --now): the merge path is on from this call, not the next
 *  checkpoint. A failed spawn doesn't roll the marker back — the next
 *  checkpoint retries; that IS the point of an install. The spawn side
 *  re-checks the marker under `daemon.up.lock` so a racing uninstall
 *  between arm and spawn doesn't leave a markerless supervisor. */
export function installDrive(
  dir: string,
  opts: { everySec: number; print?: boolean },
  deps: DriveSchedDeps = {}
): DriveInstallResult {
  if (driveMarkerPath(dir) === null) {
    return {
      state: 'error',
      detail: 'not a git repository — the install marker has no common dir to live in',
    };
  }
  if (opts.print === true) {
    return {
      state: 'printed',
      detail: [
        `# ${driveMarkerPath(dir)} — the want-marker; session checkpoints rearm a dead supervisor from it`,
        JSON.stringify({ everySec: opts.everySec, armedAt: '<install time>' }, null, 2),
        '# the supervisor itself:',
        `bro daemon run --every ${opts.everySec}   # detached; drive.lock one-per-repo`,
      ].join('\n'),
    };
  }
  const arm = armDrive(dir, opts.everySec);
  let sup: string;
  try {
    const up = (deps.up ?? supervisorUp)(dir, opts.everySec, process.env, {
      requireMarker: true,
    });
    sup = installSupLine(up, opts.everySec);
  } catch (err) {
    sup = `supervisor spawn failed (${errText(err)}) — the session checkpoint retries`;
  }
  const verb = armVerb(arm.state);
  return {
    state: arm.state === 'armed' ? 'installed' : arm.state,
    detail: `drive install ${verb} (every ${opts.everySec}s) — ${sup}; session checkpoints rearm a dead supervisor`,
  };
}

/** `bro drive uninstall` — disarm FIRST (a racing checkpoint must never
 *  rearm a dying want), then the `daemon down` sweep: SIGTERM the
 *  holder and every standby, clear the armer record. Both steps run
 *  under `daemon.up.lock`: a rearm that read the marker just before
 *  disarm waits here, then finds it gone on its locked re-check — the
 *  spawn can't land after the sweep. */
export function uninstallDrive(dir: string, deps: DriveSchedDeps = {}): DriveInstallResult {
  const upLock = daemonUpLockPath(dir);
  const release = upLock === null ? () => {} : acquireFileLock(upLock, { label: 'daemon up lock' });
  try {
    const marker = disarmDrive(dir);
    const down = (deps.down ?? supervisorDown)(dir, { kind: 'drive' });
    const removed = marker === 'disarmed' || down.hadRecord || down.pids.length > 0;
    return {
      state: removed ? 'removed' : 'absent',
      detail: [
        marker === 'disarmed' ? 'install marker removed' : 'no install marker',
        down.pids.length > 0 ? `supervisor signalled (${down.pids.join(', ')})` : '',
        down.hadRecord ? 'armer record cleared' : '',
        removed ? '' : `nothing installed for ${basename(dir)}`,
      ]
        .filter(s => s !== '')
        .join(' — '),
    };
  } finally {
    release();
  }
}

// --- the loop install want-marker --------------------------------------
// `bro loop install` mirrors drive: `<git-common>/bro/loop.json` is the
// durable want the connector's checkpoints rearm `daemon run --loop`
// from. The probe differs — the loop supervisor holds `loop.lock`, so
// its liveness plane is loopProbe, never the drive.lock truth.

export interface LoopMarker {
  /** pass cadence the rearmed supervisor runs `--every` at */
  everySec: number;
  armedAt: string;
}

/** `<git-common>/bro/loop.json` — `drive.json`'s loop-kind analogue. */
export function loopMarkerPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'loop.json');
}

/** The loop want-record — null when absent, malformed, or the repo has
 *  no common dir; readWantMarker owns the torn/cadence verdict. */
export function readLoopMarker(dir: string): LoopMarker | null {
  return readWantMarker(loopMarkerPath(dir));
}

/** Write the loop want-marker — same tmp+rename contract as `armDrive`. */
export function armLoop(dir: string, everySec: number): { state: ArmState; marker: LoopMarker } {
  const file = loopMarkerPath(dir);
  if (file === null) {
    throw new Error('not a git repository — the install marker has no common dir to live in');
  }
  const cur = readLoopMarker(dir);
  if (cur !== null && cur.everySec === everySec) {
    return { state: 'already', marker: cur };
  }
  const marker: LoopMarker = { everySec, armedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2));
  renameSync(tmp, file);
  return { state: cur === null ? 'armed' : 'updated', marker };
}

/** Remove the loop want-marker — `disarmDrive`'s mirror. */
export function disarmLoop(dir: string): 'disarmed' | 'absent' {
  const file = loopMarkerPath(dir);
  if (file === null || !existsSync(file)) {
    return 'absent';
  }
  rmSync(file);
  return 'disarmed';
}

/** The loop checkpoint decision — `driveRearm` on the loop plane:
 *  armed `loop.json` + dead `loop.lock` holder + orchestrator → rearm. */
export function loopRearm(dir: string, env: NodeJS.ProcessEnv = process.env): DriveRearm {
  if (!isOrchestratorSession(env)) {
    return { kind: 'quiet' };
  }
  const marker = readLoopMarker(dir);
  if (marker === null || loopProbe(dir).live) {
    return { kind: 'quiet' };
  }
  return { kind: 'rearm', everySec: marker.everySec };
}

/** `bro loop install` — `installDrive` on the loop plane: arm the
 *  want-marker, then bring the supervisor up (enable --now). The spawn
 *  side re-checks `loop.json` under `daemon.up.lock` — a racing
 *  uninstall still lands no markerless supervisor. */
export function installLoop(
  dir: string,
  opts: { everySec: number; print?: boolean },
  deps: LoopSchedDeps = {}
): DriveInstallResult {
  if (loopMarkerPath(dir) === null) {
    return {
      state: 'error',
      detail: 'not a git repository — the install marker has no common dir to live in',
    };
  }
  if (opts.print === true) {
    return {
      state: 'printed',
      detail: [
        `# ${loopMarkerPath(dir)} — the want-marker; session checkpoints rearm a dead supervisor from it`,
        JSON.stringify({ everySec: opts.everySec, armedAt: '<install time>' }, null, 2),
        '# the supervisor itself:',
        `bro daemon run --loop --every ${opts.everySec}   # detached; loop.lock one-per-repo`,
      ].join('\n'),
    };
  }
  const arm = armLoop(dir, opts.everySec);
  let sup: string;
  try {
    const up = (deps.up ?? supervisorUp)(dir, opts.everySec, process.env, {
      requireMarker: true,
      loop: true,
    });
    sup = installSupLine(up, opts.everySec);
  } catch (err) {
    sup = `supervisor spawn failed (${errText(err)}) — the session checkpoint retries`;
  }
  const verb = armVerb(arm.state);
  return {
    state: arm.state === 'armed' ? 'installed' : arm.state,
    detail: `loop install ${verb} (every ${opts.everySec}s) — ${sup}; session checkpoints rearm a dead supervisor`,
  };
}

/** `bro loop uninstall` — `uninstallDrive` on the loop plane: disarm
 *  FIRST (a racing checkpoint must never rearm a dying want), then the
 *  `daemon down` sweep under `daemon.up.lock`. */
export function uninstallLoop(dir: string, deps: LoopSchedDeps = {}): DriveInstallResult {
  const upLock = daemonUpLockPath(dir);
  const release = upLock === null ? () => {} : acquireFileLock(upLock, { label: 'daemon up lock' });
  try {
    const marker = disarmLoop(dir);
    const down = (deps.down ?? supervisorDown)(dir, { kind: 'loop' });
    const removed = marker === 'disarmed' || down.hadRecord || down.pids.length > 0;
    return {
      state: removed ? 'removed' : 'absent',
      detail: [
        marker === 'disarmed' ? 'install marker removed' : 'no install marker',
        down.pids.length > 0 ? `supervisor signalled (${down.pids.join(', ')})` : '',
        down.hadRecord ? 'armer record cleared' : '',
        removed ? '' : `nothing installed for ${basename(dir)}`,
      ]
        .filter(s => s !== '')
        .join(' — '),
    };
  } finally {
    release();
  }
}

export async function runDaemonCommand(argv: string[]): Promise<void> {
  const verb = argv[0];
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  if (verb === undefined) {
    usage();
  }
  const main = mainWorktree().path;
  const broCfg = loadBroConfig(main) as Record<string, unknown>;
  const isLoop = argv.includes('--loop');
  const interval = everyArg(
    argv,
    isLoop ? loopSection(broCfg.loop).everySec : driveSection(broCfg.drive).intervalSec
  );

  switch (verb) {
    case 'up':
      daemonUp(main, interval, { loop: isLoop });
      return;
    case 'run':
      // the supervised loop — drive's own guard, lock and cadence apply;
      // reached directly only via `up`'s detached spawn
      if (isLoop) {
        await runLoopCommand(['--every', String(interval)]);
        return;
      }
      await runDriveCommand(['--every', String(interval)]);
      return;
    case 'status':
      daemonStatus(main);
      return;
    case 'down':
      daemonDown(main);
      return;
    default:
      usage();
  }
}
