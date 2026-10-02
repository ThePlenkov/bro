/**
 * Agents facade — the orchestrator-connector contract for bro-managed
 * workers. Spec: specs/sessions/bro-f4ot/spec.md.
 *
 * A connector is one backend runtime (native detached processes, gascity,
 * tmux, paseo, cao). Commands never name a backend — they resolve through
 * the `connectors.agents` seam in bro.config.json (explicit pick → config
 * → matchRemote/matchDir → registry order); `native` is the designed
 * default. Backend knobs live under `agents.<backend>`.
 *
 * Two state planes, correlated on every spawn:
 *  - the beads claim — molStep in_progress/assignee in the SHARED store
 *    (`SpawnSpec.beadsDir`), the single source of truth across backends;
 *  - the agentId registry — `<git-common-dir>/bro/agents.json`, an
 *    atomic-write map molStep → {agentId, backend, spawnedAt, …} so an
 *    agent's identity survives its process.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfigSection } from './config.ts'
import { gitTry } from './git.ts'

export type AgentState = 'spawned' | 'running' | 'exited' | 'lost' | 'stopped'

/** What a backend needs to start a worker. `beadsDir` is the resolved
 *  shared-store identity — connectors MUST claim there, never in a
 *  backend-private store. */
export interface SpawnSpec {
  /** Bead id the agent claims — the stable dedup/dedup-respawn key. */
  molStep: string
  /** Worktree path the agent runs in. */
  repoRoot: string
  /** Resolved shared beads store dir — pin it into bd via BEADS_DIR. */
  beadsDir: string
  /** Rendered instructions (convoy formula text). */
  prompt: string
  env?: Record<string, string>
}

export interface AgentInfo {
  /** Stable per molStep — survives process death, reused on respawn. */
  id: string
  /** Backend-liveness handle; absent for remote backends. */
  pid?: number
  molStep: string
  backend: string
  state: AgentState
  worktree?: string
  log?: string
}

export interface AgentCapabilities {
  /** A live session can be attached to (tmux yes, native log-only no). */
  attach?: boolean
  /** spawn() can rebind a dead agent's claim to a new worker. */
  respawn?: boolean
  supervisor: 'none' | 'ondemand' | 'required'
}

/** `degraded` = the backend itself is unreachable — a failed read, NOT a
 *  dead fleet. Fleet views render it `unknown`, never `lost`. */
export interface ListResult {
  agents: AgentInfo[]
  degraded?: string
}

export interface AgentConnector {
  readonly name: string
  /** Remote-URL matcher — same precedence role as Connector.matchRemote. */
  matchRemote?(url: string): boolean
  /** Project-layout matcher — e.g. gascity claims a configDir layout. */
  matchDir?(dir: string): boolean
  /** Start a worker for spec.molStep. Throws SpawnError on
   *  duplicate/conflict (claimed by a LIVE agent). */
  spawn(spec: SpawnSpec): Promise<AgentInfo>
  list(): Promise<ListResult>
  /** Throws AgentNotFound for an id the registry doesn't know. */
  status(id: string): Promise<AgentInfo>
  /** Idempotent — a gone agent is the desired end state, not an error. */
  stop(id: string): Promise<void>
  capabilities(): AgentCapabilities
}

/** Duplicate/conflict on spawn — distinct from operational failures so
 *  callers can tell "already running" apart from "backend broken". */
export class SpawnError extends Error {
  override name = 'SpawnError'
}

export class AgentNotFound extends Error {
  override name = 'AgentNotFound'
}

// --- agentId registry ----------------------------------------------------------

/** One agents.json entry — molStep → handle. Connector-private fields
 *  (pid, exitStatus, log, worktree, stopped) ride along untyped. */
export interface AgentRegistryEntry {
  agentId: string
  backend: string
  spawnedAt: string
  [key: string]: unknown
}

/** `<git-common-dir>/bro/agents.json` — shared across linked worktrees,
 *  same anchor as the hooks markers and stack edges. */
export function agentRegistryPath(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'agents.json')
}

export function readAgentRegistry(dir: string): Record<string, AgentRegistryEntry> {
  const path = agentRegistryPath(dir)
  if (!path) {
    return {}
  }
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return {}
    }
    // entries with no agentId/backend are torn writes — drop rather than
    // let them masquerade as live agents in dedup
    const out: Record<string, AgentRegistryEntry> = {}
    for (const [k, e] of Object.entries(v)) {
      const ent = e as AgentRegistryEntry
      if (typeof ent?.agentId === 'string' && typeof ent?.backend === 'string') {
        out[k] = ent
      }
    }
    return out
  } catch {
    return {}
  }
}

/** tmp+rename — readers never see a half-written registry. */
export function writeAgentRegistry(
  dir: string,
  reg: Record<string, AgentRegistryEntry>
): void {
  const path = agentRegistryPath(dir)
  if (!path) {
    throw new Error('no git common dir — cannot write agents.json')
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Read-modify-write one molStep entry; `patch` merges over the existing
 *  entry (or over {agentId, backend, spawnedAt} when absent). */
export function patchAgentRegistry(
  dir: string,
  molStep: string,
  patch: Partial<AgentRegistryEntry>
): AgentRegistryEntry {
  const reg = readAgentRegistry(dir)
  const cur = reg[molStep] ?? { agentId: '', backend: '', spawnedAt: '' }
  const next = { ...cur, ...patch }
  reg[molStep] = next
  writeAgentRegistry(dir, reg)
  return next
}

/** Fresh id for a molStep's first spawn — respawns reuse the registry
 *  entry's id instead of minting again. */
export function mintAgentId(backend: string): string {
  return `${backend}-${randomBytes(4).toString('hex')}`
}

// --- shared-store claims -------------------------------------------------------

/** bd against a SPECIFIC store — BEADS_DIR pins the shared dolt so a
 *  connector claims where the spec says, not wherever cwd happens to
 *  resolve. Same PATH-lookup contract as core/bd.ts. */
export function bdAt(
  beadsDir: string,
  args: string[]
): { code: number; out: string; err: string } {
  const proc = spawnSync('bd', args, { // NOSONAR — PATH lookup is the contract (same as gh/git/bd)
    env: { ...process.env, BEADS_DIR: beadsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
  }
}

/** The molStep's claim state in the shared store — undefined when the
 *  bead doesn't exist (or the store can't answer). */
export function probeStep(
  beadsDir: string,
  molStep: string
): { status?: string; assignee?: string } | undefined {
  const r = bdAt(beadsDir, ['show', molStep, '--json'])
  if (r.code !== 0) {
    return undefined
  }
  try {
    const rows = JSON.parse(r.out) as { status?: string; assignee?: string }[]
    return rows[0]
  } catch {
    return undefined
  }
}

/** Fresh claim — `bd update --claim` writes the caller's actor as
 *  assignee and flips to in_progress; refused claims throw SpawnError. */
export function claimStep(beadsDir: string, molStep: string): void {
  const r = bdAt(beadsDir, ['update', molStep, '--claim'])
  if (r.code !== 0) {
    throw new SpawnError(`claim of ${molStep} refused — ${r.err || `bd exited ${r.code}`}`)
  }
}

/** Respawn rebind — the dead worker's claim transfers to the new actor.
 *  Status is already in_progress; only the assignee moves. */
export function rebindStep(beadsDir: string, molStep: string, actor: string): void {
  const r = bdAt(beadsDir, ['update', molStep, '--assignee', actor])
  if (r.code !== 0) {
    throw new SpawnError(`rebind of ${molStep} failed — ${r.err || `bd exited ${r.code}`}`)
  }
}

// --- config --------------------------------------------------------------------

/** bro.config.json `agents` section — per-backend knob bags
 *  (`agents.gascity.configDir`, `agents.native.command`). Only
 *  object-valued entries survive; connector selection stays in
 *  `connectors.agents`, not here. */
export const agentsSection: ConfigSection<Record<string, Record<string, unknown>>> = (raw) => {
  const out: Record<string, Record<string, unknown>> = {}
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.trim() !== '' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
        out[k.trim()] = v as Record<string, unknown>
      }
    }
  }
  return out
}
