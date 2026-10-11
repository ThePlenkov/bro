/**
 * The rig pulse — the rig freshness cadence under the session-pulse
 * model (bro-killn; spec specs/bro-killn.md). OS schedulers are outside
 * the agent-plugin horizon, so `bro rig install` never writes a
 * systemd unit or a crontab line — it writes a durable want-marker and
 * the session's checkpoint probes rearm a bounded `bro rig watch`
 * window from it. Three files under `<git-common>/bro/`:
 *
 *   rig-pulse.json        durable want-marker — `bro rig install` writes
 *                         it; session checkpoints rearm from it
 *   rig-pulse.lock        the liveness hold — a running `bro rig watch`
 *                         keeps it for its lifetime; live pulse =
 *                         lock-holder pid alive
 *   rig-pulse.spawn.json  the last rearm's child — a live recorded pid
 *                         suppresses the next rearm (the standby rule)
 *
 * The marker records the resolved `--repo`: the rearm must find the rig
 * again without re-running flag/config resolution. Orchestrator
 * sessions only — the BRO_AGENT_ID predicate is shared with the watch
 * pulse (`isOrchestratorSession`); spawned workers never rearm a
 * cadence they don't own.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
  gitCommonDir,
  loadConfig,
  lockHolderPid,
  pidAlive,
  worktreeGitDir,
  type Connector,
} from '@broject/core'
import { isOrchestratorSession } from './watch-pulse.ts'
import { rigSection, type RigConfig } from './rig-config.ts'

export interface RigPulseMarker {
  /** the resolved rig checkout — `bro rig watch --repo` on rearm */
  repo: string
  everySec: number
  armedAt: string
}

export function rigPulseMarkerPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'rig-pulse.json')
}

export function rigPulseLockPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'rig-pulse.lock')
}

/** The want-record — null when absent, malformed, or the repo has no
 *  common dir. Same torn-marker rule as the watch pulse: a half-shape
 *  reads as none. `repo` is required — a rearm without it would land
 *  on whatever checkout cwd happens to resolve. */
export function readRigPulseMarker(dir: string): RigPulseMarker | null {
  const file = rigPulseMarkerPath(dir)
  if (file === null || !existsSync(file)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      repo?: unknown
      everySec?: unknown
      armedAt?: unknown
    }
    return typeof raw.repo === 'string' &&
      raw.repo.trim() !== '' &&
      typeof raw.everySec === 'number' &&
      Number.isFinite(raw.everySec) &&
      raw.everySec > 0 &&
      typeof raw.armedAt === 'string'
      ? { repo: raw.repo, everySec: raw.everySec, armedAt: raw.armedAt }
      : null
  } catch {
    return null
  }
}

export type ArmState = 'armed' | 'updated' | 'already'

/** Write the want-marker (tmp+rename — the mailbox drop rule). Same
 *  repo+cadence is `already`; a changed one is `updated`. */
export function armRigPulse(
  dir: string,
  repo: string,
  everySec: number
): { state: ArmState; marker: RigPulseMarker } {
  const file = rigPulseMarkerPath(dir)
  if (file === null) {
    throw new Error('not a git repository — the rig pulse marker has no common dir to live in')
  }
  const cur = readRigPulseMarker(dir)
  if (cur !== null && cur.repo === repo && cur.everySec === everySec) {
    return { state: 'already', marker: cur }
  }
  const marker: RigPulseMarker = { repo, everySec, armedAt: new Date().toISOString() }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(marker, null, 2))
  renameSync(tmp, file)
  return { state: cur === null ? 'armed' : 'updated', marker }
}

/** Remove the want-marker. A running `bro rig watch` keeps its lock —
 *  disarming only drops the rearm intent. */
export function disarmRigPulse(dir: string): 'disarmed' | 'absent' {
  const file = rigPulseMarkerPath(dir)
  if (file === null || !existsSync(file)) {
    return 'absent'
  }
  rmSync(file)
  return 'disarmed'
}

/** Is a `bro rig watch` alive on this repo? The lock's holder pid is
 *  the whole answer — a dead holder's leftover is a stale file
 *  contenders steal, not a pulse. */
export function rigPulseLive(dir: string): { live: boolean; pid?: number } {
  const lock = rigPulseLockPath(dir)
  if (lock === null || !existsSync(lock)) {
    return { live: false }
  }
  const pid = lockHolderPid(lock)
  return pid !== null && pidAlive(pid) ? { live: true, pid } : { live: false }
}

/** The status read — what `rig status` prints as the cadence state. */
export function rigPulseState(dir: string): string {
  const marker = readRigPulseMarker(dir)
  if (marker === null) {
    return 'absent — `bro rig install` arms the session pulse'
  }
  const live = rigPulseLive(dir)
  return live.live
    ? `armed every ${marker.everySec}s — live (pid ${live.pid})`
    : `armed every ${marker.everySec}s — dead (session checkpoints rearm)`
}

export interface PulseSpawn {
  pid: number
  spawnedAt: string
}

export function rigPulseSpawnPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'rig-pulse.spawn.json')
}

export function readRigPulseSpawn(dir: string): PulseSpawn | null {
  const file = rigPulseSpawnPath(dir)
  if (file === null || !existsSync(file)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      pid?: unknown
      spawnedAt?: unknown
    }
    return typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 &&
      typeof raw.spawnedAt === 'string'
      ? { pid: raw.pid, spawnedAt: raw.spawnedAt }
      : null
  } catch {
    return null
  }
}

export function writeRigPulseSpawn(dir: string, record: PulseSpawn): void {
  const file = rigPulseSpawnPath(dir)
  if (file === null) {
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record))
  renameSync(tmp, file)
}

export type RigPulseRearm =
  | { kind: 'quiet' }
  | { kind: 'rearm'; repo: string; everySec: number; forSec: number }

/** The checkpoint decision — armed marker + dead pulse + orchestrator +
 *  no live spawned child → rearm the bounded window. Pure: the probe
 *  spawns on 'rearm', everything else stays quiet. */
export function rigPulseRearm(
  dir: string,
  pulseSec: number,
  env: NodeJS.ProcessEnv = process.env
): RigPulseRearm {
  if (!isOrchestratorSession(env)) {
    return { kind: 'quiet' }
  }
  const marker = readRigPulseMarker(dir)
  if (marker === null || rigPulseLive(dir).live) {
    return { kind: 'quiet' }
  }
  const spawned = readRigPulseSpawn(dir)
  if (spawned !== null && pidAlive(spawned.pid)) {
    return { kind: 'quiet' }
  }
  return {
    kind: 'rearm',
    repo: marker.repo,
    everySec: marker.everySec,
    forSec: Math.max(pulseSec, marker.everySec),
  }
}

/** Fire-and-forget the bounded window — detached, unref'd, stdio
 *  ignored, `process.argv[1]` re-runs this CLI entry so npx/dist/source
 *  installs all re-spawn themselves. The marker's repo rides `--repo`
 *  explicitly — the child never re-derives the target from cwd. */
export function spawnRigPulse(
  dir: string,
  repo: string,
  everySec: number,
  forSec: number
): number | null {
  const entry = process.argv[1]
  // the marker is repo-local writable state — before its `repo` can
  // steer the child it must name a worktree of THIS repo: an absolute
  // path whose common dir is the marker's own. A foreign checkout's
  // refresh commands would otherwise run under our cadence (CWE-73).
  const common = gitCommonDir(dir)
  if (
    entry === undefined ||
    common === null ||
    !isAbsolute(repo) ||
    !existsSync(repo) ||
    worktreeGitDir(repo) === null ||
    gitCommonDir(repo) !== common
  ) {
    return null
  }
  try {
    const child = spawn(
      process.execPath,
      [entry, 'rig', 'watch', '--repo', repo, '--every', String(everySec), '--for', String(forSec)],
      { cwd: repo, detached: true, stdio: 'ignore' }
    )
    child.unref()
    return child.pid ?? null
  } catch {
    return null
  }
}

/** The rig connector — the rig pulse's contribution to the lifecycle:
 *  session-start (and every tool call, same probe) rearms the armed
 *  marker when no live `bro rig watch` holds its lock. Orchestrator
 *  sessions only — same guard as the watch pulse (bro-killn). */
export const rigConnector: Connector = {
  name: 'rig',
  hooks: () => ({
    sessionStart(ctx) {
      return rigPulseCheckpoint(ctx.dir, 'session start')
    },
    postTool(ctx) {
      return rigPulseCheckpoint(ctx.dir, 'tool call')
    },
  }),
}

/** One checkpoint for every lifecycle event: decide, spawn, record,
 *  report. A failure anywhere stays silent — a probe must never break
 *  the hook event it rode in on. */
function rigPulseCheckpoint(dir: string, where: string): string[] {
  try {
    const r = rigPulseRearm(dir, rigCfg(dir).pulseSec)
    if (r.kind !== 'rearm') {
      return []
    }
    const pid = spawnRigPulse(dir, r.repo, r.everySec, r.forSec)
    if (pid === null) {
      return []
    }
    writeRigPulseSpawn(dir, { pid, spawnedAt: new Date().toISOString() })
    return [
      `rig pulse rearmed on ${where} — spawned ` +
        `\`bro rig watch --repo ${r.repo} --every ${r.everySec} --for ${r.forSec}\` (pid ${pid})`,
    ]
  } catch {
    return []
  }
}

function rigCfg(dir: string): RigConfig {
  return (
    (loadConfig(dir, { rig: rigSection }).rig as RigConfig | undefined) ?? rigSection(undefined)
  )
}
