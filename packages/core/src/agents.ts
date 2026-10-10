/**
 * Agents facade — the orchestrator-connector contract for bro-managed
 * workers. Spec: specs/sessions/bro-f4ot/spec.md.
 *
 * A connector is one backend runtime (detached processes, multiplexer
 * sessions, managed fleets). Commands never name a backend — they resolve through
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
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfigSection } from './config.ts'
import { acquireFileLock } from './filelock.ts'
import { BD_NO_STORE } from './bd.ts'
import { gitTry } from './git.ts'
import { taskStoreAt } from './tasks.ts'

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

const CAUSE_PATTERNS: [AgentCause, RegExp[]][] = [
  // no trailing \b on the rate-limit stem — identifier forms
  // (`rate_limit_exceeded`, `RateLimitError`) continue with word chars
  [
    'rate_limited',
    [
      /\brate[_ -]?limits?/i,
      /\b429\b/,
      /too many requests/i,
      /requests?\s*(?:per|[-/])\s*(?:window|second|minute|hour|day)\b/i,
    ],
  ],
  [
    'quota',
    [
      /\bquota\b/i,
      /insufficient[_ ]?(?:credits?|funds?|balance)/i,
      // 'billing' only counts beside an account-wall word — a transient
      // billing-service error is a crash, not the quota block that only
      // a manual `bro agents down` lifts
      /\bbilling\b.{0,40}\b(?:limits?|exceed\w*|declin\w*|disabl\w*|deactivat\w*|suspen\w*|overdue|unpaid|delinquen\w*|requir\w*|missing|invalid|inactiv\w*)/i,
      /\b(?:overdue|unpaid|delinquen\w*|declin\w*|disabl\w*|deactivat\w*|suspen\w*|requir\w*|missing|invalid|inactiv\w*)\b.{0,40}\bbilling\b/i,
      /out of (?:credits?|funds?)/i,
      /spend(?:ing)? limit/i,
      /(?:monthly|daily|usage) limit (?:reached|exceeded)/i,
    ],
  ],
  [
    'auth',
    [
      /\b401\b/,
      /\bunauthori[sz]ed\b/i,
      /invalid (?:api[_ -]?key|token|credentials?)/i,
      /authentication (?:failed|required|error)/i,
      /not (?:authenticated|logged in|signed in)/i,
      /(?:api[_ -]?key|token|credentials?) (?:expired|revoked|invalid)/i,
      /expired (?:api[_ -]?key|token|credentials?)/i,
    ],
  ],
]

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 }

const toIso = (ms: number): string | undefined => {
  // an absurd but finite delay overflows Date — toISOString() throws
  // RangeError, so validate before formatting and fall through
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** `retry-after: 120`, `try again in 5 minutes`, `resets in 1h` */
function relReset(text: string, now: number): string | undefined {
  const rel =
    /retry[- ]?after\s*[:=]\s*(\d+)\b/i.exec(text) ??
    /(?:try again|retry|resets?|available|ready) in (\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i.exec(
      text
    )
  if (rel === null) {
    return undefined
  }
  const n = Number(rel[1])
  if (!Number.isFinite(n) || n < 0) {
    return undefined
  }
  return toIso(now + n * (UNIT_MS[(rel[2]?.toLowerCase() ?? 's')[0]!] ?? 1_000))
}

/** Retry-After's HTTP-date form — the numeric matcher above skips it */
function httpDateReset(text: string): string | undefined {
  const m = /retry[- ]?after\s*[:=]\s*([a-z]{3},\s*\d{1,2}\s+[a-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s*GMT)/i.exec(
    text
  )
  return m === null ? undefined : toIso(Date.parse(m[1]!))
}

/** Keyword-anchored ISO stamps (`resets at 2026-10-05T23:00:00Z`) */
function isoReset(text: string): string | undefined {
  const m =
    /(?:resets?|resetting|try again|retry|until|available)\b[^\d\n]{0,32}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
      text
    )
  if (m === null) {
    return undefined
  }
  const raw = m[1]!
  return toIso(Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`))
}

/** Epoch-seconds rate-limit reset headers */
function epochReset(text: string): string | undefined {
  const m = /(?:x-ratelimit-reset|rate[_ -]?limit[_ -]?reset)\s*[:=]\s*(\d{10})\b/i.exec(text)
  return m === null ? undefined : toIso(Number(m[1]) * 1000)
}

/** Provider reset extraction across the known header/prose forms. */
function parseResetAt(text: string, now: number): string | undefined {
  return relReset(text, now) ?? httpDateReset(text) ?? isoReset(text) ?? epochReset(text)
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
  for (const [cause, patterns] of CAUSE_PATTERNS) {
    if (patterns.some((re) => re.test(logTail))) {
      const resetAt =
        cause === 'rate_limited' || cause === 'quota'
          ? parseResetAt(logTail, now)
          : undefined
      return resetAt === undefined ? { cause } : { cause, resetAt }
    }
  }
  return { cause: 'crash' }
}

/** The resolved worker payload the provider layer computed for one
 *  spawn (spec bro-5hx1.1). Opaque to the backend: when present, run
 *  IT instead of the connector's own command template.
 *    - `template`: a command string with the existing `{promptFile}`
 *      contract — cli providers and anything else that wraps an agent
 *      CLI directly.
 *    - `argv`: an executable argv — the acp driver. Backends MUST NOT
 *      string-concat it into `sh -c`; the prepared prompt file is
 *      appended as the LAST element. */
export type SpawnWorker =
  | { kind: 'template'; command: string }
  | {
      kind: 'argv'
      argv: string[]
      /** Display/agent-cli name for pins and trailers — the wrapped
       *  agent's own cli name, not the driver's. */
      cliName?: string
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
  /** Provider provenance — the configured `providers.<name>` this
   *  spawn resolved to. Recorded into the registry and pinned into
   *  the worker's env; never set for the legacy template path. */
  provider?: string
  /** The effective model (spawn flag > profile > provider entry). */
  model?: string
  /** The routing lane the spawn resolved to (fleet.routing class —
   *  spec bro-1x7p). Provenance like provider; absent on unrouted
   *  spawns (no fleet.routing declared). */
  class?: string
  /** Provider-resolved spawn payload — see SpawnWorker. */
  worker?: SpawnWorker
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
  /** Provider provenance — which `providers.<name>` ran this agent,
   *  and the effective model the worker reported or was pinned to.
   *  Absent on legacy template spawns. */
  provider?: string
  model?: string
  /** Routing lane the spawn resolved to (fleet.routing class) —
   *  absent on unrouted spawns. */
  class?: string
  worktree?: string
  log?: string
}

export interface AgentCapabilities {
  /** A live session can be attached to (a multiplexer backend yes, a
   *  detached log-only backend no). */
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
  /** Project-layout matcher — e.g. a fleet backend claims a configDir layout. */
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
  /** fleet admission refused — capacity, not conflict; callers wait.
   *  The kind rides the error so a post-refusal occupancy re-read can't
   *  race the slot that just freed */
  | 'cap'
  /** caller input — a worktree path that doesn't exist, an unsafe name */
  | 'input'
  /** server-side misconfiguration — no agent command, no common dir */
  | 'config'
  /** backend tooling missing or down — the multiplexer absent, the fleet manager unreachable */
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
 *  (pid, exitStatus, log, worktree, stopped) ride along untyped.
 *  `provider`/`model`/`acpSessionId` are typed because they carry the
 *  fleet's provenance contract (spec bro-5hx1.1), not a backend's
 *  bookkeeping — `acpSessionId` is written by the acp driver AFTER
 *  session/new, proving which protocol session ran the prompt. */
export interface AgentRegistryEntry {
  agentId: string
  backend: string
  spawnedAt: string
  provider?: string
  model?: string
  acpSessionId?: string
  /** Session-kind lane the run was admitted under — written at spawn so
   *  status/debug can see which session quota a live agent consumes. */
  sessionKind?: string
  /** Routing lane the run resolved to (fleet.routing class) — same
   *  provenance role as provider/model (spec bro-1x7p). */
  class?: string
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
      throw new SyntaxError('agents.json must contain an object')
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
    if (code === 'ENOENT') {
      return {}
    }
    // corruption/EACCES/EIO is degradation, not emptiness — a silent {}
    // lets a read-modify-write discard every known agent and lets a
    // reaper orphan every home file (bro-f6zp review)
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
    // the manual clear covers the retained `attempts` too — a superseded
    // death must stay cleared with its entry (spec bro-1x7p), otherwise a
    // shallow top-level stamp leaves the old record walling its provider
    if (patch.stopped === true && Array.isArray(next.attempts)) {
      next.attempts = (next.attempts as unknown[]).map((a) =>
        a !== null && typeof a === 'object' ? { ...a, stopped: true } : a
      )
    }
    reg[molStep] = next
    writeAgentRegistry(dir, reg)
    return next
  })
}

/** Remove entries by molStep key — the prune path for terminal
 *  records (the caller decides which states are reapable; this only
 *  guarantees the same lock+atomic-write discipline as a patch).
 *  `expected` pins the observed entry: a respawn between the caller's
 *  status snapshot and this removal rewrites agentId/spawnedAt/pid, and
 *  a changed entry is a different agent whose state was never verified
 *  — it stays. Returns the keys that were actually present and removed. */
export function removeAgentRegistryEntries(
  dir: string,
  molSteps: string[],
  expected?: ReadonlyMap<string, Partial<Pick<AgentRegistryEntry, 'agentId' | 'spawnedAt' | 'pid'>>>
): string[] {
  return withAgentRegistryLock(dir, () => {
    const reg = readAgentRegistry(dir)
    const removed: string[] = []
    for (const k of molSteps) {
      const cur = reg[k]
      if (cur === undefined) {
        continue
      }
      const seen = expected?.get(k)
      if (
        seen !== undefined &&
        (cur.agentId !== seen.agentId ||
          cur.spawnedAt !== seen.spawnedAt ||
          cur.pid !== seen.pid)
      ) {
        continue
      }
      delete reg[k]
      removed.push(k)
    }
    if (removed.length > 0) {
      writeAgentRegistry(dir, reg)
    }
    return removed
  })
}

/** Fresh id for a molStep's first spawn — respawns reuse the registry
 *  entry's id instead of minting again. */
export function mintAgentId(backend: string): string {
  return `${backend}-${randomBytes(4).toString('hex')}`
}

// --- shared-store claims -------------------------------------------------------

/** The store a shared-store claim addresses — BEADS_DIR-pinned via
 *  taskStoreAt so a connector claims where the spec says, not wherever
 *  cwd happens to resolve. The claim plane speaks the port's verbs;
 *  `bdAt` stays underneath as the env-pinned exec. */
function claimStore(beadsDir: string): ReturnType<typeof taskStoreAt> {
  return taskStoreAt(beadsDir)
}

/** The agent command's cli name — first token, basename'd and
 *  sanitized; 'agent' when nothing usable resolves. A fleet backend's
 *  provider label and the `Agent:` commit-trailer pin
 *  (specs/bro-fzot.md) both read it. */
export function commandCliName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? ''
  return /^[a-zA-Z][\w-]*$/.test(base) ? base : 'agent'
}

/** The molStep's molecule parent — the `parent` field, the `Molecule:`
 *  commit trailer's source. Best-effort like probeStep: a root bead or
 *  a dead store resolves nothing. */
export function stepParent(beadsDir: string, molStep: string): string | undefined {
  try {
    const parent = claimStore(beadsDir).get(molStep)?.parent
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  } catch {
    return undefined
  }
}

/** The molStep's claim state in the shared store — undefined when the
 *  bead doesn't exist (or the store can't answer). */
export function probeStep(
  beadsDir: string,
  molStep: string
): { status?: string; assignee?: string } | undefined {
  try {
    const row = claimStore(beadsDir).get(molStep)
    return row === undefined ? undefined : { status: row.status, assignee: row.assignee }
  } catch {
    return undefined
  }
}

/** Store failure → 'unavailable' (503 territory), a real refusal →
 *  'conflict'. `ran:false` marks a spawn failure/timeout — the store
 *  never answered. But bd can also RUN and report its store missing;
 *  that exit is the same outage, not a claim refusal. `ran`'s absence
 *  means the error came from inside the port (JSON drift) — still a
 *  refusal of a kind, not a dead store. */
function spawnClass(err: unknown): 'conflict' | 'unavailable' {
  const e = err as { ran?: unknown; stderr?: unknown; message?: string }
  if (e.ran === false) {
    return 'unavailable'
  }
  const text = `${typeof e.message === 'string' ? e.message : ''}\n${
    typeof e.stderr === 'string' ? e.stderr : ''
  }`
  return BD_NO_STORE.test(text) ? 'unavailable' : 'conflict'
}

/** Fresh claim — `claim()` writes the caller's actor as assignee and
 *  flips to in_progress; refused claims throw SpawnError. */
export function claimStep(beadsDir: string, molStep: string): void {
  try {
    claimStore(beadsDir).claim(molStep)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new SpawnError(`claim of ${molStep} refused — ${why}`, spawnClass(err))
  }
}

/** Respawn rebind — the dead worker's claim transfers to the new actor.
 *  Status is already in_progress; only the assignee moves. */
export function rebindStep(beadsDir: string, molStep: string, actor: string): void {
  try {
    claimStore(beadsDir).update(molStep, { assignee: actor })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new SpawnError(`rebind of ${molStep} failed — ${why}`, spawnClass(err))
  }
}

// --- config --------------------------------------------------------------------

/** bro.config.json `agents` section — per-backend knob bags
 *  (`agents.<backend>.configDir`, `agents.<backend>.command`). Only
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
