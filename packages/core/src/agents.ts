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
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
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
  /** Supervisor lifecycle, capability-declared: `supervisor: 'none'`
   *  backends (native) never implement these — `bro agents up|down` with
   *  no target reports them as no-ops. A supervised backend WITHOUT the
   *  methods is reported as a gap, not silently ignored. */
  up?(): Promise<void>
  down?(): Promise<void>
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
      if (
        typeof ent?.agentId === 'string' &&
        ent.agentId !== '' &&
        typeof ent?.backend === 'string' &&
        ent.backend !== ''
      ) {
        out[k] = ent
      }
    }
    return out
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (err instanceof SyntaxError || code === 'ENOENT') {
      return {}
    }
    // EACCES/EIO/etc. is degradation, not emptiness — a silent {} would
    // let the next patch discard every known agent
    throw err
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
  // pid+random — a tmp name a crashed writer's leftover can't collide with
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`)
  renameSync(tmp, path)
}

// --- registry lock ---------------------------------------------------------------

/** Lock paths this process holds — makes withAgentRegistryLock
 *  re-entrant so a locked critical section (native spawn) can call
 *  patchAgentRegistry without deadlocking on itself. */
const heldRegistryLocks = new Set<string>()

/** A dead holder leaves the lock file behind. The token carries the
 *  holder pid, so recovery proves death (kill(pid,0)) instead of
 *  guessing from age: a live holder's lock is NEVER broken on age
 *  alone — a gascity spawn legitimately holds the section through
 *  backend starts with multi-minute timeouts, and an age-only break
 *  would let a contender double-spawn alongside it. STALE covers
 *  unparseable/dead-pid residue; ORPHAN is the live-pid backstop for
 *  pid reuse (a recorded pid now owned by an unrelated process), set
 *  beyond any legit critical section. The wait bound stays far below
 *  STALE: a contender that can't take the lock fails fast with a
 *  retryable error rather than stealing it. */
const REGISTRY_LOCK_STALE_MS = 60_000
const REGISTRY_LOCK_ORPHAN_MS = 15 * 60_000
const REGISTRY_LOCK_WAIT_MS = 20_000

const syncSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** pid alive = kill(pid, 0) doesn't throw. EPERM means the process
 *  exists but isn't ours — still alive. Local copy: core can't import
 *  the cli's pidAlive. */
const lockPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** One acquisition attempt — true when the lock is ours. On EEXIST a
 *  stale lock is broken so the next retry can take it — but only once
 *  the holder is proven dead (unparseable token or dead pid past
 *  STALE, or anything past ORPHAN). The file carries the caller's
 *  token: existence is the lock, the token is the ownership proof
 *  release() checks before removing it. */
const tryAcquireLockFile = (lock: string, token: string): boolean => {
  try {
    const fd = openSync(lock, 'wx')
    try {
      writeSync(fd, token)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
  }
  try {
    // ownership-checked stale break — read the holder token FIRST, then
    // prove stale AND unchanged. A contender that already replaced the
    // file shows a fresh mtime or a different token — either way the
    // delete is skipped instead of robbing its fresh lock.
    const holder = readFileSync(lock, 'utf8')
    const pid = Number(holder.split(':')[0])
    const holderAlive = Number.isInteger(pid) && pid > 0 && lockPidAlive(pid)
    const age = Date.now() - statSync(lock).mtimeMs
    if (
      age > (holderAlive ? REGISTRY_LOCK_ORPHAN_MS : REGISTRY_LOCK_STALE_MS) &&
      readFileSync(lock, 'utf8') === holder
    ) {
      rmSync(lock, { force: true })
    }
  } catch {
    // raced removal or a stat flake — the retry decides
  }
  return false
}

/** Advisory inter-process lock on `<agents.json>.lock` (O_EXCL create —
 *  existence IS the lock). Serializes registry read-modify-write across
 *  bro processes: without it two spawns both read the pre-write state
 *  and the loser's patch is silently dropped. Returns the release. */
export function acquireAgentRegistryLock(
  dir: string,
  opts: { waitMs?: number } = {}
): () => void {
  const path = agentRegistryPath(dir)
  if (!path) {
    throw new Error('no git common dir — cannot lock agents.json')
  }
  mkdirSync(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  if (heldRegistryLocks.has(lock)) {
    return () => {} // re-entrant — the outer section owns it
  }
  const waitMs = opts.waitMs ?? REGISTRY_LOCK_WAIT_MS
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + waitMs
  while (!tryAcquireLockFile(lock, token)) {
    if (Date.now() >= deadline) {
      throw new Error(`agents.json lock held over ${waitMs / 1000}s`)
    }
    syncSleep(25)
  }
  heldRegistryLocks.add(lock)
  return () => {
    heldRegistryLocks.delete(lock)
    try {
      // a section that overran the stale window may have been broken and
      // re-acquired by a contender — remove the file only while it still
      // carries OUR token, or release would drop the new holder's lock
      if (readFileSync(lock, 'utf8') === token) {
        rmSync(lock, { force: true })
      }
    } catch {
      // lock already gone — the desired end state
    }
  }
}

/** Run `fn` under the registry lock. Sync-only on purpose — an async
 *  fn would release-and-reattach semantics nobody needs here; the
 *  native spawn section is synchronous top to bottom. */
export function withAgentRegistryLock<T>(dir: string, fn: () => T): T {
  const release = acquireAgentRegistryLock(dir)
  try {
    return fn()
  } finally {
    release()
  }
}

/** Read-modify-write one molStep entry; `patch` merges over the existing
 *  entry (or over {agentId, backend, spawnedAt} when absent). */
export function patchAgentRegistry(
  dir: string,
  molStep: string,
  patch: Partial<AgentRegistryEntry>
): AgentRegistryEntry {
  return withAgentRegistryLock(dir, () => {
    const reg = readAgentRegistry(dir)
    const cur = reg[molStep] ?? { agentId: '', backend: '', spawnedAt: '' }
    const next = { ...cur, ...patch }
    reg[molStep] = next
    writeAgentRegistry(dir, reg)
    return next
  })
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
    const why = r.err !== '' ? r.err : `bd exited ${r.code}`
    throw new SpawnError(`claim of ${molStep} refused — ${why}`)
  }
}

/** Respawn rebind — the dead worker's claim transfers to the new actor.
 *  Status is already in_progress; only the assignee moves. */
export function rebindStep(beadsDir: string, molStep: string, actor: string): void {
  const r = bdAt(beadsDir, ['update', molStep, '--assignee', actor])
  if (r.code !== 0) {
    const why = r.err !== '' ? r.err : `bd exited ${r.code}`
    throw new SpawnError(`rebind of ${molStep} failed — ${why}`)
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
