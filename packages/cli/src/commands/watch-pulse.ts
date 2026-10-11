/**
 * The session pulse — the orchestrator-owned cadence that replaced the
 * systemd/crontab installs (bro-killn; spec specs/bro-killn.md). Two
 * files under `<git-common>/bro/`:
 *
 *   pulse.json   durable want-marker — `bro watch install` writes it,
 *                session-start rearms a dead pulse from it
 *   pulse.lock   the liveness hold — a running `bro watch --every` keeps
 *                it heartbeated for its lifetime (spec bro-2duu9); live
 *                pulse = lock-holder pid alive
 *
 * The orchestrator predicate is the same one the mailbox uses for its
 * `orchestrator` address: `BRO_AGENT_ID` unset means the session is an
 * orchestrator — spawned workers pin it and must never arm the cadence.
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
import { dirname, join } from 'node:path'
import {
  gitCommonDir,
  loadConfig,
  lockHolderPid,
  pidAlive,
  type Connector,
} from '@broject/core'
import { watchSection, type WatchConfig } from './watch-config.ts'

export interface PulseMarker {
  /** tick cadence the armed pulse runs `--every` at */
  everySec: number
  armedAt: string
}

export function pulseMarkerPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'pulse.json')
}

export function pulseLockPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'pulse.lock')
}

/** The want-record — null when absent, malformed, or the repo has no
 *  common dir. A torn marker is the same answer as none: the nudge
 *  stays quiet rather than rearming from a half-shape. */
export function readPulseMarker(dir: string): PulseMarker | null {
  const file = pulseMarkerPath(dir)
  if (file === null || !existsSync(file)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      everySec?: unknown
      armedAt?: unknown
    }
    return typeof raw.everySec === 'number' &&
      Number.isFinite(raw.everySec) &&
      raw.everySec > 0 &&
      typeof raw.armedAt === 'string'
      ? { everySec: raw.everySec, armedAt: raw.armedAt }
      : null
  } catch {
    return null
  }
}

export type ArmState = 'armed' | 'updated' | 'already'

/** Write the want-marker (tmp+rename — the mailbox drop rule). Same
 *  cadence is `already` and leaves the file alone; a changed one is
 *  `updated`. */
export function armPulse(dir: string, everySec: number): { state: ArmState; marker: PulseMarker } {
  const file = pulseMarkerPath(dir)
  if (file === null) {
    throw new Error('not a git repository — the pulse marker has no common dir to live in')
  }
  const cur = readPulseMarker(dir)
  if (cur !== null && cur.everySec === everySec) {
    return { state: 'already', marker: cur }
  }
  const marker: PulseMarker = { everySec, armedAt: new Date().toISOString() }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(marker, null, 2))
  renameSync(tmp, file)
  return { state: cur === null ? 'armed' : 'updated', marker }
}

export type DisarmState = 'disarmed' | 'absent'

/** Remove the want-marker. The running pulse (if any) keeps its lock —
 *  disarming only drops the rearm intent. */
export function disarmPulse(dir: string): DisarmState {
  const file = pulseMarkerPath(dir)
  if (file === null || !existsSync(file)) {
    return 'absent'
  }
  rmSync(file)
  return 'disarmed'
}

/** Is a `bro watch --every` alive on this repo? The lock's holder pid
 *  is the whole answer — a dead holder's leftover is a stale file
 *  contenders steal, not a pulse. */
export function pulseLive(dir: string): { live: boolean; pid?: number } {
  const lock = pulseLockPath(dir)
  if (lock === null || !existsSync(lock)) {
    return { live: false }
  }
  const pid = lockHolderPid(lock)
  return pid !== null && pidAlive(pid) ? { live: true, pid } : { live: false }
}

/** The orchestrator predicate — `BRO_AGENT_ID` unset/empty, identical
 *  to the `orchestrator` mailbox address rule in core/notify.ts.
 *  Spawned workers pin the var at spawn; they never arm pulses. */
export function isOrchestratorSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const id = env.BRO_AGENT_ID
  return id === undefined || id === ''
}

export interface PulseSpawn {
  pid: number
  spawnedAt: string
}

/** `<git-common>/bro/pulse.spawn.json` — the last rearm's child. A live
 *  recorded pid suppresses the next rearm whether it already holds the
 *  lock (the pulse) or still waits behind another contender (a standby)
 *  — without it every postTool would pile another standby on a dead
 *  incumbent. */
export function pulseSpawnPath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'pulse.spawn.json')
}

export function readPulseSpawn(dir: string): PulseSpawn | null {
  const file = pulseSpawnPath(dir)
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

export function writePulseSpawn(dir: string, record: PulseSpawn): void {
  const file = pulseSpawnPath(dir)
  if (file === null) {
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, file)
}

export type PulseRearm = { kind: 'quiet' } | { kind: 'rearm'; everySec: number; forSec: number }

/** The postTool checkpoint decision — armed marker + dead pulse +
 *  orchestrator + no live spawned child → rearm the bounded window.
 *  Pure: the probe spawns on 'rearm', everything else stays quiet. */
export function pulseRearm(
  dir: string,
  pulseSec: number,
  env: NodeJS.ProcessEnv = process.env
): PulseRearm {
  if (!isOrchestratorSession(env)) {
    return { kind: 'quiet' }
  }
  const marker = readPulseMarker(dir)
  if (marker === null || pulseLive(dir).live) {
    return { kind: 'quiet' }
  }
  const spawned = readPulseSpawn(dir)
  if (spawned !== null && pidAlive(spawned.pid)) {
    return { kind: 'quiet' }
  }
  return { kind: 'rearm', everySec: marker.everySec, forSec: Math.max(pulseSec, marker.everySec) }
}

/** Fire-and-forget the bounded window — detached, unref'd, stdio
 *  ignored: the hook exits on its timeout budget while the child takes
 *  pulse.lock (or stands by behind a contender and inherits later).
 *  `process.argv[1]` re-runs this CLI entry so npx/dist/source installs
 *  all re-spawn themselves. */
export function spawnPulse(dir: string, everySec: number, forSec: number): number | null {
  const entry = process.argv[1]
  if (entry === undefined) {
    return null
  }
  try {
    const child = spawn(
      process.execPath,
      [entry, 'watch', '--every', String(everySec), '--for', String(forSec), '--notify'],
      { cwd: dir, detached: true, stdio: 'ignore' }
    )
    child.unref()
    return child.pid ?? null
  } catch {
    return null
  }
}

/** The session-start rearm nudge — armed marker + no live pulse +
 *  orchestrator session → the rearm command; everything else is quiet.
 *  `--for` floors at the cadence so a weird config can't suggest an
 *  invalid pair (`--for` must be ≥ `--every`). */
export function pulseNudge(
  dir: string,
  pulseSec: number,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!isOrchestratorSession(env)) {
    return null
  }
  const marker = readPulseMarker(dir)
  if (marker === null || pulseLive(dir).live) {
    return null
  }
  const win = Math.max(pulseSec, marker.everySec)
  return (
    `watch pulse armed (every ${marker.everySec}s) but not live — rearm: ` +
    `\`bro watch --every ${marker.everySec} --for ${win} --notify\`; ` +
    'on window end run one `bro drive` pass, digest, re-arm'
  )
}

/** The watch connector — the pulse's contribution to the lifecycle:
 *  session-start (and post-compaction, same probe) rearms the armed
 *  marker when no live `bro watch --every` holds the pulse lock.
 *  Orchestrator sessions only — a spawned worker (BRO_AGENT_ID pinned)
 *  never sees the nudge, so workers never recurse watchers (bro-killn).
 *  Lives here, not in watch.ts, so plugins.ts can register it without
 *  pulling the command's dependency tree into a circular import. */
export const watchConnector: Connector = {
  name: 'watch',
  hooks: () => ({
    // session start is the first checkpoint — same rearm path as
    // postTool: armed + dead → spawn the bounded window, don't ask
    sessionStart(ctx) {
      return pulseCheckpoint(ctx.dir, 'session start')
    },
    // every tool call is a checkpoint: an armed marker with a dead
    // pulse gets a fresh bounded window spawned right here — the
    // zero-cost rearm (shell, no LLM) that makes the cadence
    // self-perpetuating while the orchestrator works. A standby child
    // or a live pulse is quiet (bro-killn)
    postTool(ctx) {
      return pulseCheckpoint(ctx.dir, 'tool call')
    },
  }),
}

/** One checkpoint for every lifecycle event: decide, spawn, record,
 *  report. A failure anywhere stays silent — a probe must never break
 *  the hook event it rode in on. */
function pulseCheckpoint(dir: string, where: string): string[] {
  try {
    const r = pulseRearm(dir, pulseCfg(dir).pulseSec)
    if (r.kind !== 'rearm') {
      return []
    }
    const pid = spawnPulse(dir, r.everySec, r.forSec)
    if (pid === null) {
      return []
    }
    writePulseSpawn(dir, { pid, spawnedAt: new Date().toISOString() })
    return [
      `watch pulse rearmed on ${where} — spawned ` +
        `\`bro watch --every ${r.everySec} --for ${r.forSec} --notify\` (pid ${pid})`,
    ]
  } catch {
    return []
  }
}

function pulseCfg(dir: string): WatchConfig {
  return (
    (loadConfig(dir, { watch: watchSection }).watch as WatchConfig | undefined) ??
    watchSection(undefined)
  )
}
