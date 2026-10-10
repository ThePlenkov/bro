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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitCommonDir, lockHolderPid, pidAlive } from '@broject/core'
import { flag } from './args.ts'
import { driveLockPath, runDriveCommand } from './drive.ts'
import { driveSection, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'
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
}

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
      ? { pid: rec.pid, everySec: rec.everySec, spawnedAt: rec.spawnedAt ?? '', cmd: rec.cmd ?? '' }
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
  if (recorded !== null && pidAlive(recorded.pid)) {
    return { live: true, pid: recorded.pid, recorded }
  }
  return { live: false, recorded }
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

/** Spawn the supervisor loop detached — same fire-and-forget shape as
 *  the pulse rearm: own process group, parent-unref'd, argv[1] so dist
 *  and source installs both re-spawn themselves. Unlike the pulse the
 *  daemon gets a real log — an owner must be debuggable. */
export function spawnDaemon(dir: string, everySec: number): { pid: number; log: string | null } {
  const log = daemonLogPath(dir)
  const broDir = daemonStatePath(dir)
  if (broDir !== null) {
    mkdirSync(join(broDir, '..'), { recursive: true })
  }
  const out = log === null ? 'ignore' : openSync(log, 'a')
  const child = spawn(
    process.execPath,
    [process.argv[1]!, 'daemon', 'run', '--every', String(everySec)],
    { cwd: dir, detached: true, stdio: ['ignore', out, out] }
  )
  child.unref()
  writeDaemonRecord(dir, {
    pid: child.pid!,
    everySec,
    spawnedAt: new Date().toISOString(),
    cmd: `bro daemon run --every ${everySec}`,
  })
  return { pid: child.pid!, log }
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

export async function runDaemonCommand(argv: string[]): Promise<void> {
  const verb = argv[0]
  if (verb === undefined || argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  const main = mainWorktree().path
  const broCfg = loadBroConfig(main) as Record<string, unknown>
  const interval = everyArg(argv, driveSection(broCfg.drive).intervalSec)

  switch (verb) {
    case 'up': {
      const decision = daemonUpDecision(main)
      if (decision.kind === 'refuse-worker') {
        console.error(
          'error: BRO_AGENT_ID is set — spawned workers never arm the daemon; ' +
            'the orchestrator session owns it'
        )
        process.exit(2)
      }
      if (decision.kind === 'already') {
        console.log(`daemon up — already supervising (pid ${decision.pid})`)
        return
      }
      const spawned = spawnDaemon(main, interval)
      console.log(
        `daemon up — pid ${spawned.pid} every ${interval}s` +
          (spawned.log === null ? '' : ` — log ${spawned.log}`)
      )
      return
    }
    case 'run': {
      // the supervised loop — drive's own guard, lock and cadence apply;
      // reached directly only via `up`'s detached spawn
      await runDriveCommand(['--every', String(interval)])
      return
    }
    case 'status': {
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
      return
    }
    case 'down': {
      const probe = daemonProbe(main)
      const state = daemonStatePath(main)
      if (!probe.live) {
        if (state !== null) {
          rmSync(state, { force: true })
        }
        console.log('daemon down — no live supervisor')
        return
      }
      try {
        process.kill(probe.pid!, 'SIGTERM')
      } catch (err) {
        console.error(`error: SIGTERM to ${probe.pid} failed — ${errText(err)}`)
        process.exit(1)
      }
      if (state !== null) {
        rmSync(state, { force: true })
      }
      console.log(`daemon down — pid ${probe.pid} signalled`)
      return
    }
    default:
      usage()
  }
}
