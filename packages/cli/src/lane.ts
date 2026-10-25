/**
 * The lane's pacing mechanics (spec bro-y3jvd) — two mechanisms over
 * the provider wall the routing layer derives:
 *
 * 1. The rate gate: `providers.<name>.rateGate` arms a host-shared
 *    token bucket per lane model (`<lane>/<model>` under
 *    `$XDG_STATE_HOME/bro/lane-gate/`). A BATCH spawn pays its
 *    `spawnCost` request-tokens at admission; an empty bucket refuses
 *    with 'cap' + retryAfter. The fleet paces to the account ceiling
 *    instead of discovering it by dying. Interactive spawns never
 *    consult it — the operator's lane is not throttled.
 * 2. The wall pause: while a provider wall holds, `SIGSTOP` the live
 *    workers' process groups — the account is shared, so the lane is
 *    the unit. A worker frozen mid-turn stops feeding the wall
 *    (every attempt pushes the reset out); `SIGCONT` on lift resumes
 *    it where it left off. Records live in `lane-pause.json` so a
 *    reconcile knows who to thaw and never signals a recycled pid.
 *    `providers.<name>.wallPause: false` opts out.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  agentRegistryPath,
  deriveProviderWalls,
  isBatchSpawn,
  laneGateDir,
  laneGateLevel,
  laneGateTake,
  pidAlive,
  readAgentRegistry,
  SpawnError,
  wallText,
  type AgentRegistryEntry,
  type LaneRateGate,
  type ProviderEntry,
  type ProviderWall,
  type SpawnSpec,
} from '@broject/core'
import { groupMemberAlive, providerWallsFor, type AgentConnectorEnv } from './agent-connectors.ts'

// --- the rate gate ------------------------------------------------------

/** The bucket key's lane half — a shared `lane` name lets two provider
 *  entries that resolve to the same account (`devin` + `devin-acp`)
 *  draw one budget. */
const laneOf = (name: string, gate: LaneRateGate): string => gate.lane ?? name

/** Spawn-surface entries carry rateGate; api entries never spawn. */
function gateOf(entry: ProviderEntry | undefined): LaneRateGate | undefined {
  return entry !== undefined && (entry.type === 'cli' || entry.type === 'acp')
    ? entry.rateGate
    : undefined
}

/** The bucket key's model half — an unmodeled spawn draws the
 *  `(default)` bucket (the free-model lane pins no model). */
const modelOf = (spec: SpawnSpec, entry: ProviderEntry | undefined): string =>
  spec.model ??
  (entry !== undefined && 'model' in entry ? entry.model : undefined) ??
  '(default)'

/** Charge a batch spawn against its lane's token bucket — returns the
 *  refusal, or undefined when admitted (no gate, interactive lane,
 *  tokens available). Runs inside the caller's registry-lock section:
 *  a refused spawn leaves no half-state either way. */
export function laneGateRefusal(
  env: AgentConnectorEnv,
  spec: SpawnSpec,
  now = Date.now()
): SpawnError | undefined {
  if (spec.provider === undefined || !isBatchSpawn(spec.env)) {
    return undefined
  }
  const entry = env.providers?.[spec.provider]
  const gate = gateOf(entry)
  if (gate === undefined) {
    return undefined
  }
  const lane = laneOf(spec.provider, gate)
  const model = modelOf(spec, entry)
  const take = laneGateTake(lane, model, gate, now)
  if (take.ok) {
    return undefined
  }
  return new SpawnError(
    `provider ${spec.provider} lane '${lane}' out of request budget (${model})` +
      ` — rateGate ${gate.requestsPerHour} req/h · ${gate.spawnCost}/spawn` +
      `; retry in ~${take.retryAfterSec}s` +
      (spec.molStep !== undefined ? ` — spawn of ${spec.molStep} refused` : ''),
    'cap'
  )
}

// --- the wall pause -----------------------------------------------------

/** A frozen process group — pidStart pins identity so a recycled pid
 *  is never signaled (or reported) as ours. */
interface PauseRecord {
  provider: string
  molStep: string
  agentId: string
  pidStart?: string
  pausedAt: string
}

interface PauseFile {
  paused: Record<string, PauseRecord>
}

/** `<git-common>/bro/lane-pause.json` — repo-scoped like the registry
 *  the walls derive from. */
export function lanePausePath(dir: string): string | null {
  const regPath = agentRegistryPath(dir)
  return regPath === null ? null : join(dirname(regPath), 'lane-pause.json')
}

function readPauseFile(path: string): PauseFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PauseFile>
    if (raw.paused !== null && typeof raw.paused === 'object') {
      return { paused: raw.paused as Record<string, PauseRecord> }
    }
  } catch {
    // missing/corrupt — start clean; a torn pause file must not strand
    // records nobody will thaw (the reconcile re-freezes what should
    // be frozen anyway)
  }
  return { paused: {} }
}

function writePauseFile(path: string, file: PauseFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`)
  renameSync(tmp, path)
}

const sig = (pgid: number, signal: 'SIGSTOP' | 'SIGCONT'): boolean => {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

/** Does this provider pause on walls? Default ON — a walled account
 *  is rejecting work, and a running worker can only push the reset
 *  out. `wallPause: false` opts out. */
const pauseWanted = (env: AgentConnectorEnv, provider: string): boolean => {
  const entry = env.providers?.[provider]
  return entry === undefined || !('wallPause' in entry) || entry.wallPause !== false
}

const groupLive = (entry: AgentRegistryEntry): boolean => {
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined
  if (pid === undefined) {
    return false
  }
  const start =
    typeof entry.pidStart === 'string' && entry.pidStart !== '' ? entry.pidStart : undefined
  return pidAlive(pid, start) || groupMemberAlive(pid, start)
}

/** A recorded pause still points at the same registry row — a respawn
 *  or stop replaces the entry, and the new pid is the reconcile's
 *  problem, not this record's. */
function entryStillOurs(rec: PauseRecord, registry: Record<string, AgentRegistryEntry>): boolean {
  const cur = registry[rec.molStep]
  return cur !== undefined && cur.agentId === rec.agentId && cur.stopped !== true
}

/** Assert the pause state the walls imply — freeze newly-walled live
 *  workers, thaw what the wall no longer covers, drop records whose
 *  pids are gone or recycled. `registry`/`walls` may be caller-supplied
 *  (prepareSpawn already holds both under the registry lock). */
function reconcile(
  env: AgentConnectorEnv,
  registry: Record<string, AgentRegistryEntry>,
  walls: ProviderWall[],
  path: string,
  now: number
): { paused: number; thawed: number } {
  const walled = new Map(walls.map((w) => [w.provider, w]))
  const file = readPauseFile(path)
  const next: Record<string, PauseRecord> = {}
  let thawed = 0

  // freeze — every live registry worker on a walled provider. The
  // wall is an account fact, so the lane is the unit: interactive
  // registry workers pause too (bro-owned labor stops spending the
  // shared account); the operator's own terminal sessions are not
  // registry entries and are never touched.
  for (const [molStep, entry] of Object.entries(registry)) {
    if (
      entry.provider === undefined ||
      !walled.has(entry.provider) ||
      entry.stopped === true ||
      !pauseWanted(env, entry.provider) ||
      typeof entry.pid !== 'number' ||
      !groupLive(entry)
    ) {
      continue
    }
    const pid = entry.pid
    if (file.paused[String(pid)] === undefined && sig(pid, 'SIGSTOP')) {
      file.paused[String(pid)] = {
        provider: entry.provider,
        molStep,
        agentId: entry.agentId,
        pidStart: typeof entry.pidStart === 'string' ? entry.pidStart : undefined,
        pausedAt: new Date(now).toISOString(),
      }
    }
  }

  // thaw/drop — a record survives while its provider still walls AND
  // its pid still resolves to the same process. Dead or recycled pids
  // drop WITHOUT a signal — never SIGCONT a stranger.
  for (const [pidStr, rec] of Object.entries(file.paused)) {
    const pid = Number(pidStr)
    const alive = Number.isInteger(pid) && pidAlive(pid, rec.pidStart)
    if (!alive) {
      continue
    }
    if (walled.has(rec.provider) && pauseWanted(env, rec.provider) && entryStillOurs(rec, registry)) {
      next[pidStr] = rec
      continue
    }
    if (sig(pid, 'SIGCONT')) {
      thawed++
    }
  }

  if (Object.keys(next).length > 0 || Object.keys(file.paused).length > 0 || existsSync(path)) {
    writePauseFile(path, { paused: next })
  }
  return { paused: Object.keys(next).length, thawed }
}

/** The periodic/idle call — reads the registry and derives walls
 *  itself (providerWallsFor harvests pending exit causes first, so a
 *  fresh rate_limited death walls this pass, not the next). */
export function reconcileLanePause(
  dir: string,
  env: AgentConnectorEnv,
  now = Date.now()
): { walled: ProviderWall[]; paused: number; thawed: number } {
  const path = lanePausePath(dir)
  if (path === null) {
    return { walled: [], paused: 0, thawed: 0 }
  }
  const walls = providerWallsFor(dir)
  const { paused, thawed } = reconcile(env, readAgentRegistry(dir), walls, path, now)
  return { walled: walls, paused, thawed }
}

/** The spawn-path call — the caller's locked registry snapshot is
 *  authoritative (a fresh read mid-lock would see the same file
 *  anyway; threading it through keeps the critical section's reads
 *  consistent). Walls re-derive from that same snapshot. */
export function reconcileLanePauseForRegistry(
  dir: string,
  env: AgentConnectorEnv,
  registry: Record<string, AgentRegistryEntry>,
  now = Date.now()
): { walled: ProviderWall[]; paused: number; thawed: number } {
  const path = lanePausePath(dir)
  if (path === null) {
    return { walled: [], paused: 0, thawed: 0 }
  }
  const walls = deriveProviderWalls(registry, now)
  const { paused, thawed } = reconcile(env, registry, walls, path, now)
  return { walled: walls, paused, thawed }
}

// --- status ---------------------------------------------------------------

export interface LaneStatusRow {
  provider: string
  wall?: ProviderWall
  paused: number
  gate?: Array<{ model: string; tokens: number; capacity: number }>
}

/** The lane section `bro agents status` renders: walled providers,
 *  frozen-worker counts, and armed-gate levels. Walls derive read-only
 *  here — status never harvests causes (a read that writes is the
 *  spawn path's laziness, not a report's). */
export function laneStatus(dir: string, env: AgentConnectorEnv, now = Date.now()): LaneStatusRow[] {
  let registry: Record<string, AgentRegistryEntry> = {}
  try {
    registry = readAgentRegistry(dir)
  } catch {
    // no git dir / unreadable registry — the lane section is empty
  }
  const walls = new Map(deriveProviderWalls(registry, now).map((w) => [w.provider, w]))
  const pausedBy = new Map<string, number>()
  const pausePath = lanePausePath(dir)
  if (pausePath !== null) {
    for (const rec of Object.values(readPauseFile(pausePath).paused)) {
      pausedBy.set(rec.provider, (pausedBy.get(rec.provider) ?? 0) + 1)
    }
  }
  const rows = new Map<string, LaneStatusRow>()
  const row = (p: string): LaneStatusRow => {
    let r = rows.get(p)
    if (r === undefined) {
      r = { provider: p, paused: pausedBy.get(p) ?? 0 }
      rows.set(p, r)
    }
    return r
  }
  for (const [provider, w] of walls) {
    row(provider).wall = w
  }
  for (const provider of pausedBy.keys()) {
    row(provider)
  }
  for (const [name, entry] of Object.entries(env.providers ?? {})) {
    const gate = gateOf(entry)
    if (gate === undefined) {
      continue
    }
    row(name).gate = gateLevels(laneOf(name, gate), gate, now)
  }
  return [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider))
}

/** Every bucket file under `<lane>/` — models the gate has touched. */
function gateLevels(
  lane: string,
  gate: LaneRateGate,
  now: number
): Array<{ model: string; tokens: number; capacity: number }> {
  const dir = laneGateDir()
  const prefix = encodeURIComponent(`${lane}/`)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ model: string; tokens: number; capacity: number }> = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) {
      continue
    }
    const model = decodeURIComponent(name.slice(prefix.length, -'.json'.length))
    const level = laneGateLevel(lane, model, gate, now, dir)
    if (level !== null) {
      out.push({ model, ...level })
    }
  }
  return out
}

/** The status table's lane lines — one per walled/paused provider,
 *  one per armed gate bucket. */
export function laneStatusLines(rows: LaneStatusRow[]): string[] {
  const lines: string[] = []
  for (const r of rows) {
    if (r.wall !== undefined) {
      lines.push(
        `  ${r.provider}: ${wallText(r.wall)}` +
          (r.paused > 0 ? ` · ${r.paused} worker${r.paused === 1 ? '' : 's'} paused` : '')
      )
    } else if (r.paused > 0) {
      lines.push(`  ${r.provider}: ${r.paused} worker${r.paused === 1 ? '' : 's'} paused`)
    }
    for (const g of r.gate ?? []) {
      lines.push(`  ${r.provider}: gate ${g.model} — ${g.tokens}/${g.capacity} req budget`)
    }
  }
  return lines
}
