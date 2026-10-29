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
 */
import { execFileSync, spawn } from 'node:child_process';
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
import { driveSection, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts';
import { SELF_ENTRY } from './self-entry.ts';
import { readWantMarker } from './want-marker.ts';
import { isOrchestratorSession } from './watch-pulse.ts';
import { mainWorktree } from './work.ts';
import { loadBroConfig } from '../plugins.ts';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    'Usage: bro daemon <up|status|down|run> [--every SEC]\n' +
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
   *  on older records, which the probe trusts only briefly after
   *  `spawnedAt` (the pre-lock window is seconds anyway) */
  pidStart?: string;
}

/** Records without a `pidStart` are trusted this long after `spawnedAt`
 *  — long enough to cover the pre-lock window, short enough that a
 *  reused pid can't impersonate the daemon forever. */
const RECORD_TRUST_MS = 120_000;

/** `<git-common>/bro/daemon.json` — who armed the daemon. Written by
 *  `up`, removed by `down`; distinct from `drive.lock`, which is the
 *  supervisor's own liveness hold. A record without a live holder is
 *  the watchdog's "daemon died" signal. */
export function daemonStatePath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'daemon.json');
}

export function daemonLogPath(dir: string): string | null {
  const common = gitCommonDir(dir);
  return common === null ? null : join(common, 'bro', 'daemon.log');
}

export function readDaemonRecord(dir: string): DaemonRecord | null {
  const file = daemonStatePath(dir);
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

function writeDaemonRecord(dir: string, rec: DaemonRecord): void {
  const file = daemonStatePath(dir);
  if (file === null) {
    return;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Who is supervising right now — the `drive.lock` holder when alive,
 *  else a still-alive recorded armer (child spawned, not yet holding).
 *  `staleLock` bounds the holder check the way a contender's steal
 *  does: `pidAlive` alone is reuse-blind (the token is `pid:hex`, no
 *  start time), so a hold whose heartbeat aged past the abandoned
 *  bound doesn't count even while its pid lives — a recycled pid
 *  masks a dead supervisor for one window at most, never forever. */
export function daemonProbe(dir: string): {
  live: boolean;
  pid?: number;
  recorded: DaemonRecord | null;
} {
  const lock = driveLockPath(dir);
  const lockLive = lock !== null && existsSync(lock) && !staleLock(lock);
  const lockPid = lockLive ? lockHolderPid(lock) : null;
  const recorded = readDaemonRecord(dir);
  if (lockPid !== null && pidAlive(lockPid)) {
    return { live: true, pid: lockPid, recorded };
  }
  if (recorded !== null && recordedPidAlive(recorded)) {
    return { live: true, pid: recorded.pid, recorded };
  }
  return { live: false, recorded };
}

/** A recorded pid is trusted only with its stored start time; records that
 *  predate the field cannot be verified against reuse and must not be
 *  trusted to kill processes. */
function recordedPidAlive(rec: DaemonRecord, now: number = Date.now()): boolean {
  if (rec.pidStart !== undefined) {
    return pidAlive(rec.pid, rec.pidStart);
  }
  if (rec.spawnedAt) {
    const spawned = Date.parse(rec.spawnedAt);
    if (Number.isFinite(spawned) && now - spawned <= RECORD_TRUST_MS) {
      return pidAlive(rec.pid);
    }
  }
  return false;
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
  env: NodeJS.ProcessEnv = process.env
): DaemonUpDecision {
  if (!isOrchestratorSession(env)) {
    return { kind: 'refuse-worker' };
  }
  const probe = daemonProbe(dir);
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
export function spawnDaemon(dir: string, everySec: number): { pid: number; log: string | null } {
  const log = daemonLogPath(dir);
  const broDir = daemonStatePath(dir);
  if (broDir !== null) {
    mkdirSync(join(broDir, '..'), { recursive: true });
  }
  const out = log === null ? 'ignore' : openSync(log, 'a');
  const child = spawn(
    process.execPath,
    [SELF_ENTRY!, 'daemon', 'run', '--every', String(everySec)],
    {
      cwd: dir,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, BRO_LOG_TIMESTAMP: '1' },
    }
  );
  child.unref();
  try {
    writeDaemonRecord(dir, {
      pid: child.pid!,
      everySec,
      spawnedAt: new Date().toISOString(),
      cmd: `bro daemon run --every ${everySec}`,
      pidStart: procStat(child.pid!)?.start,
    });
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
 *  --every` children plus raw `bro drive --every` runs (they hold the
 *  same lock, so `down` owes them the same SIGTERM or a standby
 *  quietly inherits it). The pgrep match is machine-wide, so each hit
 *  is re-scoped by repo: the candidate's /proc cwd must resolve to the
 *  same git common dir as `dir` — a raw drive started in a linked
 *  worktree resolves to it, a supervisor serving another repo (the
 *  rig's own daemon included) never does. A candidate whose ownership
 *  can't be verified — no /proc, cwd raced away, outside any repo —
 *  is spared: the sweep errs toward missing a standby, never toward
 *  killing a stranger. */
function supervisionProcs(dir: string): number[] {
  const common = gitCommonDir(dir);
  if (common === null) {
    return [];
  }
  let pids: number[];
  try {
    const out = execFileSync('pgrep', ['-f', '(daemon run|drive) --every'], {
      // NOSONAR — pgrep is a required runtime dep; env below pins PATH to fixed unwriteable dirs
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // fixed, unwriteable PATH for the binary lookup — the default
      // inherited PATH can contain user-writable dirs (sonar S4036)
      env: { PATH: '/usr/bin:/bin' },
    });
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
    return gitCommonDir(readlinkSync(`/proc/${pid}/cwd`));
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
  opts: { requireMarker?: boolean } = {}
): SupervisorUp {
  const upLock = daemonUpLockPath(dir);
  const release = upLock === null ? () => {} : acquireFileLock(upLock, { label: 'daemon up lock' });
  try {
    const decision = daemonUpDecision(dir, env);
    if (decision.kind === 'refuse-worker') {
      return { kind: 'refuse-worker' };
    }
    if (decision.kind === 'already') {
      return { kind: 'already', pid: decision.pid };
    }
    if (opts.requireMarker === true && readDriveMarker(dir) === null) {
      return { kind: 'disarmed' };
    }
    const spawned = spawnDaemon(dir, everySec);
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
 *  could inherit its lock (standbys wait on drive.lock), then clear the
 *  armer record. `daemon down`'s core; `drive uninstall` runs the same
 *  sweep after disarming the marker. */
export function supervisorDown(dir: string): SupervisorDown {
  const probe = daemonProbe(dir);
  const state = daemonStatePath(dir);
  const victims = new Set<number>([
    ...(probe.live ? [probe.pid!] : []),
    ...(probe.recorded !== null && recordedPidAlive(probe.recorded) ? [probe.recorded.pid] : []),
    ...supervisionProcs(dir),
  ]);
  victims.delete(process.pid);
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone — SIGTERM is advisory, absence is not a failure
    }
  }
  const hadRecord = state !== null && existsSync(state);
  if (state !== null) {
    rmSync(state, { force: true });
  }
  return { pids: [...victims], hadRecord };
}

function logWithTs(msg: string): void {
  if (process.env.BRO_LOG_TIMESTAMP === '1') {
    try {
      const ts = new Date().toISOString();
      process.stdout.write(`[${ts}] ${msg}\n`);
      return;
    } catch {}
  }
  console.log(msg);
}
function errWithTs(msg: string): void {
  if (process.env.BRO_LOG_TIMESTAMP === '1') {
    try {
      const ts = new Date().toISOString();
      process.stderr.write(`[${ts}] ${msg}\n`);
      return;
    } catch {}
  }
  console.error(msg);
}

function daemonUp(main: string, interval: number): void {
  const up = supervisorUp(main, interval);
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
  const log = daemonLogPath(main);
  const marker = readDriveMarker(main);
  const installed = marker === null ? '' : ` · installed (every ${marker.everySec}s)`;
  if (!probe.live) {
    logWithTs(
      (probe.recorded === null
        ? `daemon down — no supervisor; 'bro daemon up' to start`
        : `daemon down — recorded pid ${probe.recorded.pid} is dead`) + installed
    );
    return;
  }
  logWithTs(
    `daemon up — pid ${probe.pid} supervising` +
      (probe.recorded === null ? ' (unrecorded holder)' : `, armed ${probe.recorded.spawnedAt}`) +
      installed +
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
  logWithTs(
    [
      pids.length === 0
        ? 'daemon down — no live supervisor'
        : `daemon down — signalled ${pids.join(', ')}`,
      // under an install, down is a transient stop — the next session
      // checkpoint rearms from the marker; uninstall is the disarm
      readDriveMarker(main) !== null
        ? `installed — the next session checkpoint rearms it; 'bro drive uninstall' disarms`
        : '',
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

/** Write the want-marker (tmp+rename — the mailbox drop rule). Same
 *  cadence is `already` and leaves the file alone; a changed one is
 *  `updated`. */
export function armDrive(
  dir: string,
  everySec: number
): { state: 'armed' | 'updated' | 'already'; marker: DriveMarker } {
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
    opts?: { requireMarker?: boolean }
  ) => SupervisorUp;
  down?: (dir: string) => SupervisorDown;
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
    sup =
      up.kind === 'spawned'
        ? `supervisor up — pid ${up.pid} every ${opts.everySec}s`
        : up.kind === 'already'
          ? `already supervising (pid ${up.pid})`
          : up.kind === 'disarmed'
            ? 'supervisor not spawned — a racing uninstall disarmed it'
            : 'supervisor spawn refused — workers never arm it';
  } catch (err) {
    sup = `supervisor spawn failed (${errText(err)}) — the session checkpoint retries`;
  }
  const verb =
    arm.state === 'already' ? 'already armed' : arm.state === 'updated' ? 're-armed' : 'armed';
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
    const down = (deps.down ?? supervisorDown)(dir);
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
  const interval = everyArg(argv, driveSection(broCfg.drive).intervalSec);

  switch (verb) {
    case 'up':
      daemonUp(main, interval);
      return;
    case 'run':
      // the supervised loop — drive's own guard, lock and cadence apply;
      // reached directly only via `up`'s detached spawn
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
