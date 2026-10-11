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
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireFileLock, gitCommonDir, lockHolderPid, pidAlive, procStat } from '@broject/core'
import { flag } from './args.ts'
import { driveLockPath, runDriveCommand } from './drive.ts'
import { driveSection, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'
import { SELF_ENTRY } from './self-entry.ts'
import { isOrchestratorSession } from './watch-pulse.ts'
import { mainWorktree } from './work.ts'
import { loadBroConfig } from '../plugins.ts'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function usage(): never {
  console.error(
    'Usage: bro daemon <up|status|down|run> [--every SEC]\n' +
      '  up      spawn the detached supervisor (orchestrator sessions only)\n' +
      '  status  supervisor liveness — lock holder, armer record, log path\n' +
      '  down    SIGTERM the supervisor and clear the armer record\n' +
      '  run     the supervised loop itself — spawned by `up`, not for direct use'
  )
  process.exit(2)
}

export interface DaemonRecord {
  pid: number
  everySec: number
  spawnedAt: string
  cmd: string
  /** the child's /proc start time — pins the pid against reuse; absent
   *  on older records, which the probe trusts only briefly after
   *  `spawnedAt` (the pre-lock window is seconds anyway) */
  pidStart?: string
}

/** Records without a `pidStart` are trusted this long after `spawnedAt`
 *  — long enough to cover the pre-lock window, short enough that a
 *  reused pid can't impersonate the daemon forever. */
const RECORD_TRUST_MS = 120_000

/** `<git-common>/bro/daemon.json` — who armed the daemon. Written by
 *  `up`, removed by `down`; distinct from `drive.lock`, which is the
 *  supervisor's own liveness hold. A record without a live holder is
 *  the watchdog's "daemon died" signal. */
export function daemonStatePath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'daemon.json')
}

export function daemonLogPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'daemon.log')
}

export function readDaemonRecord(dir: string): DaemonRecord | null {
  const file = daemonStatePath(dir)
  if (file === null || !existsSync(file)) {
    return null
  }
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<DaemonRecord>
    return typeof rec.pid === 'number' && typeof rec.everySec === 'number'
      ? {
          pid: rec.pid,
          everySec: rec.everySec,
          spawnedAt: rec.spawnedAt ?? '',
          cmd: rec.cmd ?? '',
          pidStart: typeof rec.pidStart === 'string' ? rec.pidStart : undefined,
        }
      : null
  } catch {
    return null
  }
}

function writeDaemonRecord(dir: string, rec: DaemonRecord): void {
  const file = daemonStatePath(dir)
  if (file === null) {
    return
  }
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n')
  renameSync(tmp, file)
}

/** Who is supervising right now — the `drive.lock` holder when alive,
 *  else a still-alive recorded armer (child spawned, not yet holding). */
export function daemonProbe(dir: string): {
  live: boolean
  pid?: number
  recorded: DaemonRecord | null
} {
  const lock = driveLockPath(dir)
  const lockPid = lock !== null && existsSync(lock) ? lockHolderPid(lock) : null
  const recorded = readDaemonRecord(dir)
  if (lockPid !== null && pidAlive(lockPid)) {
    return { live: true, pid: lockPid, recorded }
  }
  if (recorded !== null && recordedPidAlive(recorded)) {
    return { live: true, pid: recorded.pid, recorded }
  }
  return { live: false, recorded }
}

/** A recorded pid is trusted with its stored start time; records that
 *  predate the field get the bounded post-spawn window only — a reused
 *  pid must not impersonate the daemon forever. */
function recordedPidAlive(rec: DaemonRecord, now: number = Date.now()): boolean {
  if (rec.pidStart !== undefined) {
    return pidAlive(rec.pid, rec.pidStart)
  }
  const spawnedAt = Date.parse(rec.spawnedAt)
  if (!Number.isFinite(spawnedAt) || now - spawnedAt > RECORD_TRUST_MS) {
    return false
  }
  return pidAlive(rec.pid)
}

export type DaemonUpDecision =
  | { kind: 'refuse-worker' }
  | { kind: 'already'; pid: number }
  | { kind: 'spawn' }

/** `up` is idempotent: a live supervisor (daemon-spawned or a raw
 *  `bro drive --every`) reports rather than doubles; workers pin
 *  BRO_AGENT_ID and never arm one. */
export function daemonUpDecision(
  dir: string,
  env: NodeJS.ProcessEnv = process.env
): DaemonUpDecision {
  if (!isOrchestratorSession(env)) {
    return { kind: 'refuse-worker' }
  }
  const probe = daemonProbe(dir)
  return probe.live ? { kind: 'already', pid: probe.pid! } : { kind: 'spawn' }
}

/** `<git-common>/bro/daemon.up.lock` — serializes the up path's
 *  decide→spawn→record sequence; concurrent `up` calls otherwise both
 *  see no live holder and both spawn (the child's own drive.lock makes
 *  the second a standby, but two spawns is still a lie about "never
 *  doubles"). */
function daemonUpLockPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'daemon.up.lock')
}

/** Spawn the supervisor loop detached — same fire-and-forget shape as
 *  the pulse rearm: own process group, parent-unref'd, SELF_ENTRY so
 *  dist and source installs both re-spawn themselves. Unlike the pulse the
 *  daemon gets a real log — an owner must be debuggable. The record is
 *  best-effort: `drive.lock` is the liveness truth, `daemon.json` only
 *  says who armed it — a failed write warns, never orphans the report. */
export function spawnDaemon(dir: string, everySec: number): { pid: number; log: string | null } {
  const log = daemonLogPath(dir)
  const broDir = daemonStatePath(dir)
  if (broDir !== null) {
    mkdirSync(join(broDir, '..'), { recursive: true })
  }
  const out = log === null ? 'ignore' : openSync(log, 'a')
  const child = spawn(
    process.execPath,
    [SELF_ENTRY!, 'daemon', 'run', '--every', String(everySec)],
    { cwd: dir, detached: true, stdio: ['ignore', out, out] }
  )
  child.unref()
  try {
    writeDaemonRecord(dir, {
      pid: child.pid!,
      everySec,
      spawnedAt: new Date().toISOString(),
      cmd: `bro daemon run --every ${everySec}`,
      pidStart: procStat(child.pid!)?.start,
    })
  } catch (err) {
    // an unrecorded child is an unsupervised supervisor — kill it and
    // fail, never leave a daemon nobody can see
    try {
      child.kill('SIGTERM')
    } catch {
      // exited before the write failed — nothing to clean
    }
    throw err
  }
  return { pid: child.pid!, log }
}

/** Every supervision-loop process — `daemon run --every` children plus
 *  raw `bro drive --every` runs (they hold the same lock, so `down`
 *  owes them the same SIGTERM or a standby quietly inherits it). */
function supervisionProcs(): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', '(daemon run|drive) --every'], { // NOSONAR — pgrep is a required runtime dep; env below pins PATH to fixed unwriteable dirs
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // fixed, unwriteable PATH for the binary lookup — the default
      // inherited PATH can contain user-writable dirs (sonar S4036)
      env: { PATH: '/usr/bin:/bin' },
    })
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function everyArg(argv: string[], fallback: number): number {
  const raw = flag(argv, '--every')
  if (raw === undefined) {
    return fallback
  }
  const everySec = Number(raw)
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs seconds ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}, got "${raw}"`
    )
    process.exit(2)
  }
  return everySec
}

function daemonUp(main: string, interval: number): void {
  const decision = daemonUpDecision(main)
  if (decision.kind === 'refuse-worker') {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm the daemon; ' +
        'the orchestrator session owns it'
    )
    process.exit(2)
  }
  const upLock = daemonUpLockPath(main)
  const release =
    upLock === null ? () => {} : acquireFileLock(upLock, { label: 'daemon up lock' })
  try {
    // re-decide inside the mutex — a concurrent `up` that won the
    // lock may already hold a live holder by now
    const inner = daemonUpDecision(main)
    if (inner.kind === 'already') {
      console.log(`daemon up — already supervising (pid ${inner.pid})`)
      return
    }
    const spawned = spawnDaemon(main, interval)
    console.log(
      `daemon up — pid ${spawned.pid} every ${interval}s` +
        (spawned.log === null ? '' : ` — log ${spawned.log}`)
    )
  } finally {
    release()
  }
}

function daemonStatus(main: string): void {
  const probe = daemonProbe(main)
  const log = daemonLogPath(main)
  if (!probe.live) {
    console.log(
      probe.recorded === null
        ? `daemon down — no supervisor; 'bro daemon up' to start`
        : `daemon down — recorded pid ${probe.recorded.pid} is dead`
    )
    return
  }
  console.log(
    `daemon up — pid ${probe.pid} supervising` +
      (probe.recorded === null ? ' (unrecorded holder)' : `, armed ${probe.recorded.spawnedAt}`) +
      (log === null ? '' : ` — log ${log}`)
  )
}

function daemonDown(main: string): void {
  const probe = daemonProbe(main)
  const state = daemonStatePath(main)
  // standby children waiting on drive.lock survive a holder kill
  // and take the lock over — `down` must reach every supervision
  // loop, not only the current holder
  const victims = new Set<number>([
    ...(probe.live ? [probe.pid!] : []),
    ...(probe.recorded !== null && pidAlive(probe.recorded.pid, probe.recorded.pidStart)
      ? [probe.recorded.pid]
      : []),
    ...supervisionProcs(),
  ])
  victims.delete(process.pid)
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone — SIGTERM is advisory, absence is not a failure
    }
  }
  if (state !== null) {
    rmSync(state, { force: true })
  }
  console.log(
    victims.size === 0
      ? 'daemon down — no live supervisor'
      : `daemon down — signalled ${[...victims].join(', ')}`
  )
}

export async function runDaemonCommand(argv: string[]): Promise<void> {
  const verb = argv[0]
  if (verb === undefined || argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  const main = mainWorktree().path
  const broCfg = loadBroConfig(main) as Record<string, unknown>
  const interval = everyArg(argv, driveSection(broCfg.drive).intervalSec)

  switch (verb) {
    case 'up':
      daemonUp(main, interval)
      return
    case 'run':
      // the supervised loop — drive's own guard, lock and cadence apply;
      // reached directly only via `up`'s detached spawn
      await runDriveCommand(['--every', String(interval)])
      return
    case 'status':
      daemonStatus(main)
      return
    case 'down':
      daemonDown(main)
      return
    default:
      usage()
  }
}
