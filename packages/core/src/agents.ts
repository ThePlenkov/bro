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
import { acquireFileLock } from './filelock.ts'
import { gitTry } from './git.ts'

export type AgentState = 'spawned' | 'running' | 'exited' | 'lost' | 'stopped' | 'blocked'

/** Why a recorded exit happened — classified from the agent's log TAIL,
 *  never the exit code: the same rc=1 covers a crash and a provider
 *  budget wall (specs/bro-7xgk.2.md). */
export const AGENT_CAUSES = ['ok', 'crash', 'rate_limited', 'quota', 'auth'] as const
export type AgentCause = (typeof AGENT_CAUSES)[number]

export const isAgentCause = (v: unknown): v is AgentCause =>
  typeof v === 'string' && (AGENT_CAUSES as readonly string[]).includes(v)

export interface ExitClassification {
  cause: AgentCause
  /** Provider-reported reset, ISO — parsed from the same log tail. */
  resetAt?: string
}

const CAUSE_PATTERNS: [AgentCause, RegExp][] = [
  // no trailing \b on the rate-limit stem — identifier forms
  // (`rate_limit_exceeded`, `RateLimitError`) continue with word chars
  [
    'rate_limited',
    /\brate[_ -]?limits?|\b429\b|too many requests|requests?\s*(?:per|[-/])\s*(?:window|second|minute|hour|day)\b/i,
  ],
  [
    'quota',
    /\bquota\b|insufficient[_ ]?(?:credits?|funds?|balance)|\bbilling\b|out of (?:credits?|funds?)|spend(?:ing)? limit|(?:monthly|daily|usage) limit (?:reached|exceeded)/i,
  ],
  [
    'auth',
    /\b401\b|\bunauthori[sz]ed\b|invalid (?:api[_ -]?key|token|credentials?)|authentication (?:failed|required|error)|not (?:authenticated|logged in|signed in)|(?:api[_ -]?key|token|credentials?) (?:expired|revoked|invalid)|expired (?:api[_ -]?key|token|credentials?)/i,
  ],
]

/** Provider reset extraction — relative durations (`retry-after: 120`,
 *  `try again in 5 minutes`, `resets in 1h`), keyword-anchored ISO
 *  stamps (`resets at 2026-10-05T23:00:00Z`), and epoch-seconds
 *  rate-limit reset headers. */
function parseResetAt(text: string, now: number): string | undefined {
  const rel =
    /retry[- ]?after\s*[:=]\s*(\d+)\b/i.exec(text) ??
    /(?:try again|retry|resets?|available|ready) in (\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i.exec(
      text
    )
  if (rel !== null) {
    const n = Number(rel[1])
    if (Number.isFinite(n) && n >= 0) {
      const unit = rel[2]?.toLowerCase() ?? 's'
      const ms = n * (unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000)
      // an absurd but finite delay overflows Date — toISOString() throws
      // RangeError, so validate before formatting and fall through
      const reset = new Date(now + ms)
      if (!Number.isNaN(reset.getTime())) {
        return reset.toISOString()
      }
    }
  }
  // Retry-After's HTTP-date form — the numeric matcher above skips it
  const httpDate =
    /retry[- ]?after\s*[:=]\s*([A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s*GMT)/i.exec(
      text
    )
  if (httpDate !== null) {
    const t = Date.parse(httpDate[1]!)
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString()
    }
  }
  const iso =
    /(?:resets?|resetting|try again|retry|until|available)\b[^\d\n]{0,32}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
      text
    )
  if (iso !== null) {
    const raw = iso[1]!
    const t = Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`)
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString()
    }
  }
  const epoch = /(?:x-ratelimit-reset|rate[_ -]?limit[_ -]?reset)\s*[:=]\s*(\d{10})\b/i.exec(text)
  if (epoch !== null) {
    return new Date(Number(epoch[1]) * 1000).toISOString()
  }
  return undefined
}

/** Classify a recorded exit from the log tail — the exit code only
 *  proves death; the TEXT says why. exit 0 is always `ok`; a non-zero
 *  exit matching no budget/auth pattern is `crash`. Reset parsing runs
 *  for the budget causes (a quota can carry a reset too). */
export function classifyExitCause(
  logTail: string,
  exitStatus: number,
  now = Date.now()
): ExitClassification {
  if (exitStatus === 0) {
    return { cause: 'ok' }
  }
  for (const [cause, re] of CAUSE_PATTERNS) {
    if (re.test(logTail)) {
      const resetAt =
        cause === 'rate_limited' || cause === 'quota'
          ? parseResetAt(logTail, now)
          : undefined
      return resetAt === undefined ? { cause } : { cause, resetAt }
    }
  }
  return { cause: 'crash' }
}

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
  /** Registry generation token — a respawn reuses `id` but re-stamps
   *  spawnedAt, so a liveness verdict probed for one generation must
   *  not be inherited by the next. */
  spawnedAt?: string
  /** Backend-liveness handle; absent for remote backends. */
  pid?: number
  molStep: string
  backend: string
  state: AgentState
  /** Exit classification — set once a recorded death was classified;
   *  absent on live agents, unclassifiable deaths, and pre-taxonomy
   *  entries not yet re-read. */
  cause?: AgentCause
  /** Provider-reported reset (ISO) riding a rate_limited/quota cause. */
  resetAt?: string
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

/** Why a spawn refused — the reply surface maps the kind to a status
 *  (409/400/500/503) instead of string-matching the message. */
export type SpawnErrorKind =
  /** claim refused, live agent, foreign backend — a real conflict */
  | 'conflict'
  /** caller input — a worktree path that doesn't exist, an unsafe name */
  | 'input'
  /** server-side misconfiguration — no agent command, no common dir */
  | 'config'
  /** backend tooling missing or down — tmux absent, gc unreachable */
  | 'unavailable'

/** Duplicate/conflict on spawn — distinct from operational failures so
 *  callers can tell "already running" apart from "backend broken". */
export class SpawnError extends Error {
  override name = 'SpawnError'
  /** assigned in the body — parameter properties don't survive node's
   *  strip-only TS mode, and this file is spawned as a subprocess */
  readonly kind: SpawnErrorKind
  constructor(message: string, kind: SpawnErrorKind = 'conflict') {
    super(message)
    this.kind = kind
  }
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

/** Whether the entry's recorded cause still forbids respawn — a
 *  `rate_limited` death blocks until the provider's `resetAt` passes,
 *  or indefinitely when none was reported; `quota` is an account wall
 *  and holds until the operator clears it whatever resetAt says.
 *  `stopped` lifts it: `bro agents down` is the manual clear. */
export function agentEntryBlocked(entry: AgentRegistryEntry, now = Date.now()): boolean {
  if (entry.stopped === true) {
    return false
  }
  if (entry.cause === 'quota') {
    return true
  }
  if (entry.cause !== 'rate_limited') {
    return false
  }
  const reset = typeof entry.resetAt === 'string' ? Date.parse(entry.resetAt) : Number.NaN
  return Number.isNaN(reset) || reset > now
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

/** Advisory inter-process lock on `<agents.json>.lock` — serializes
 *  registry read-modify-write across bro processes: without it two
 *  spawns both read the pre-write state and the loser's patch is
 *  silently dropped. Mechanics live in filelock.ts — liveness-proven
 *  steal for dead holders, an abandoned bound for live ones, atomic
 *  publish, and exit-hook release. Returns the release. */
export function acquireAgentRegistryLock(
  dir: string,
  opts: { waitMs?: number } = {}
): () => void {
  const path = agentRegistryPath(dir)
  if (!path) {
    throw new Error('no git common dir — cannot lock agents.json')
  }
  return acquireFileLock(`${path}.lock`, {
    label: 'agents.json lock',
    waitMs: opts.waitMs,
  })
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
): { code: number; out: string; err: string; ran: boolean } {
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
    err: (
      proc.stderr ||
      proc.error?.message ||
      (proc.signal !== null ? `killed by ${proc.signal}` : '')
    ).trim(),
    // ran = bd executed to a real exit — ENOENT, a timeout kill, or a
    // signal means the store never answered, so a non-zero code is
    // degradation ('unavailable'), not a refusal ('conflict')
    ran: proc.error === undefined && proc.status !== null,
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
    // bd itself missing/hung is the store being down — 503 territory,
    // not a claim conflict
    throw new SpawnError(`claim of ${molStep} refused — ${why}`, r.ran ? 'conflict' : 'unavailable')
  }
}

/** Respawn rebind — the dead worker's claim transfers to the new actor.
 *  Status is already in_progress; only the assignee moves. */
export function rebindStep(beadsDir: string, molStep: string, actor: string): void {
  const r = bdAt(beadsDir, ['update', molStep, '--assignee', actor])
  if (r.code !== 0) {
    const why = r.err !== '' ? r.err : `bd exited ${r.code}`
    throw new SpawnError(`rebind of ${molStep} failed — ${why}`, r.ran ? 'conflict' : 'unavailable')
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
