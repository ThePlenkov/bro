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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ConfigSection } from './config.ts'
import { acquireFileLock, LockTimeout, withFileLock } from './filelock.ts'
import { gitTry } from './git.ts'
import { pidAlive } from './proc.ts'

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
  /** fleet admission refused — capacity, not conflict; callers wait.
   *  The kind rides the error so a post-refusal occupancy re-read can't
   *  race the slot that just freed */
  | 'cap'
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
  /** Session-kind lane the run was admitted under ('devin') — written at
   *  spawn so status/debug can see which quota a live agent consumes. */
  sessionKind?: string
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

/** The agent command's cli name — first token, basename'd and
 *  sanitized; 'agent' when nothing usable resolves. gascity's provider
 *  label and the `Agent:` commit-trailer pin (specs/bro-fzot.md) both
 *  read it. */
export function commandCliName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? ''
  return /^[a-zA-Z][\w-]*$/.test(base) ? base : 'agent'
}

/** The molStep's molecule parent — `bd show`'s `parent` field, the
 *  `Molecule:` commit trailer's source. Best-effort like probeStep: a
 *  root bead or a dead store resolves nothing. */
export function stepParent(beadsDir: string, molStep: string): string | undefined {
  const r = bdAt(beadsDir, ['show', molStep, '--json'])
  if (r.code !== 0) {
    return undefined
  }
  try {
    const parent = (JSON.parse(r.out) as { parent?: unknown }[])[0]?.parent
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

// --- devin session quota -------------------------------------------------------

/** The devin CLI's session-lock dir — `$XDG_DATA_HOME/devin/cli/
 *  session_locks` (its own state plane: every local devin session —
 *  interactive, `-p`, `acp` — drops a `<name>.lock` holding its pid).
 *  `agents.devin.lockDir` overrides for odd installs/tests. `env` is
 *  the environment the derivation reads — a worker spawned with its
 *  own XDG_DATA_HOME/HOME resolves a different dir. */
export function devinLocksDir(
  lockDir?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (typeof lockDir === 'string' && lockDir.trim() !== '') {
    return lockDir
  }
  const xdg = env['XDG_DATA_HOME']
  const home = env['HOME']
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : join(
          home !== undefined && home.trim() !== '' ? home : homedir(),
          '.local',
          'share'
        )
  return join(base, 'devin', 'cli', 'session_locks')
}

/** Every dir the admission scan must cover: the resolved lock dir
 *  plus the worker's own effective one — `spec.env` can hand the
 *  spawned session a different XDG_DATA_HOME/HOME, and its devin lock
 *  lands THERE, invisible to a scan of only the spawner's dir. The
 *  quota stays per-account: sessions under other OS users' homes are
 *  unreadable and out of scope. */
export function devinLocksDirs(
  lockDir?: string,
  workerEnv?: Record<string, string>
): string[] {
  const dirs = [devinLocksDir(lockDir)]
  if (workerEnv !== undefined) {
    const eff = devinLocksDir(undefined, { ...process.env, ...workerEnv })
    if (eff !== dirs[0]) {
      dirs.push(eff)
    }
  }
  return dirs
}

/** Live devin sessions on this host — lock files whose pid is alive,
 *  deduplicated (a resumed session holds a second lock for the same
 *  process). A missing dir means no devin install → zero sessions; any
 *  OTHER read failure throws SpawnError('unavailable') — an unverifiable
 *  quota must fail closed, never silently admit past the cap. Same
 *  rule per lock file: one that vanished mid-scan was never counted,
 *  one that can't be read (EACCES, EISDIR) fails the count.
 *  Non-pid content counts nothing — a strict digit check keeps a
 *  corrupt `123oops`/`0x10` lock from aliasing an unrelated live pid.
 *  Cloud-side sessions (devin_session_create via MCP) never write a
 *  local lock — this is a host-local count, the blind spot is
 *  documented. Accepts one dir or several (the worker's effective
 *  env can put its locks elsewhere — see devinLocksDirs). */
export function countDevinSessions(lockDir?: string | string[]): number {
  const dirs = Array.isArray(lockDir) ? lockDir : [devinLocksDir(lockDir)]
  const live = new Set<number>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw new SpawnError(`cannot verify devin session count — ${dir}: ${(err as Error).message}`, 'unavailable')
    }
    for (const name of names) {
      if (!name.endsWith('.lock')) {
        continue
      }
      let raw: string
      try {
        raw = readFileSync(join(dir, name), 'utf8').trim()
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw new SpawnError(`cannot verify devin session count — ${dir}/${name}: ${(err as Error).message}`, 'unavailable')
      }
      if (!/^\d+$/.test(raw)) {
        continue
      }
      const pid = Number.parseInt(raw, 10)
      if (pidAlive(pid)) {
        live.add(pid)
      }
    }
  }
  return live.size
}

// --- spawn reservations --------------------------------------------------------

/** How long a claimed-but-not-yet-locked devin session counts. The real
 *  devin lock lands within seconds of the child starting; 120s covers
 *  that handoff plus failure cleanup, then the file self-expires. */
export const DEVIN_RESERVATION_TTL_MS = 120_000

/** Host-shared reservation dir — `$XDG_DATA_HOME/bro/devin-reservations`.
 *  Cross-repo by construction: every bro process on this host admits
 *  against the same set, closing the window between "count says headroom"
 *  and "the spawned devin wrote its own lock". */
export function devinReservationsDir(resDir?: string): string {
  if (typeof resDir === 'string' && resDir.trim() !== '') {
    return resDir
  }
  const xdg = process.env['XDG_DATA_HOME']
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'bro', 'devin-reservations')
}

/** Fresh reservations — files younger than the TTL count as claimed
 *  slots; stale files are reaped in passing. A missing dir is zero
 *  reservations; other read failures throw 'unavailable', same
 *  fail-closed rule as the lock scan. */
export function countDevinReservations(resDir?: string): number {
  const dir = devinReservationsDir(resDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw new SpawnError(`cannot verify devin reservations — ${dir}: ${(err as Error).message}`, 'unavailable')
  }
  const now = Date.now()
  let fresh = 0
  for (const name of names) {
    if (!name.endsWith('.lock')) {
      continue
    }
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs < DEVIN_RESERVATION_TTL_MS) {
        fresh++
      } else {
        rmSync(path, { force: true })
      }
    } catch {
      // stat raced a reap — ignore
    }
  }
  return fresh
}

/** Claim a host-wide slot — the filename carries a random suffix, so a
 *  same-named spawn from another repo never overwrites a live claim.
 *  Returns the reservation path for release on failure. */
export function reserveDevinSession(resDir: string | undefined, key: string): string {
  const dir = devinReservationsDir(resDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${key}-${randomBytes(4).toString('hex')}.lock`)
  writeFileSync(path, String(Date.now()), { flag: 'wx' })
  return path
}

/** Drop a reservation — spawn-failure cleanup; on success the file is
 *  left to expire behind the devin child's own lock. */
export function releaseDevinSession(path: string): void {
  rmSync(path, { force: true })
}

/** Atomic host-wide admission: the session+reservation count and the
 *  claim write run under ONE mutex shared by every repo — the agents
 *  registry lock is per-repo and cannot serialize this, so without it
 *  two spawns each count below the cap and both start. Returns the
 *  reservation path — released by the caller when the spawn fails
 *  before a session exists; a landed session needs no release (its
 *  own lock is the count, the file ages out). Throws SpawnError —
 *  'config' when the cap is misconfigured, 'cap' when full,
 *  'unavailable' when the count can't be established or the mutex
 *  outlives its wait. */
export function admitDevinSession(
  quota: {
    maxSessions: number
    lockDir?: string
    reservationsDir?: string
    invalid?: boolean
  },
  opts: { key: string; molStep?: string; workerEnv?: Record<string, string> }
): string {
  const resDir = devinReservationsDir(quota.reservationsDir)
  try {
    return withFileLock(
      // no .lock suffix — the reservation counter globs '*.lock' and
      // the mutex must never count itself as a claimed slot
      join(resDir, 'admission.mutex'),
      () => {
        if (quota.invalid === true) {
          // a present-but-unparsable cap is a config bug — refuse
          // loudly rather than spawn past a quota the operator armed
          throw new SpawnError(
            `agents.devin.maxSessions must be a positive integer` +
              (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
            'config'
          )
        }
        const live =
          countDevinSessions(devinLocksDirs(quota.lockDir, opts.workerEnv)) +
          countDevinReservations(quota.reservationsDir)
        if (live >= quota.maxSessions) {
          throw new SpawnError(
            `devin session quota reached — ${live}/${quota.maxSessions} live sessions ` +
              `(agents.devin.maxSessions in bro.config)` +
              (opts.molStep !== undefined ? ` — spawn of ${opts.molStep} refused` : ''),
            'cap'
          )
        }
        return reserveDevinSession(quota.reservationsDir, opts.key)
      },
      { label: 'devin session quota admission' }
    )
  } catch (err) {
    if (err instanceof LockTimeout) {
      throw new SpawnError(`devin quota admission lock held — ${err.message}`, 'unavailable')
    }
    throw err
  }
}

export interface DevinSessionQuota {
  /** Host-wide cap on live devin sessions — spawn refuses at/above it.
   *  0 or absent means uncapped. */
  maxSessions: number
  /** `agents.devin.lockDir` — override for the lock scan (tests, odd
   *  installs). */
  lockDir?: string
  /** `agents.devin.reservationsDir` — override for the reservation scan. */
  reservationsDir?: string
  /** `maxSessions` was present but not a positive integer — a config
   *  typo must surface as an error at admission, never silently
   *  unguard the quota. */
  invalid?: boolean
}

/** `agents.devin` → the quota a devin-session spawn must fit under.
 *  undefined when the section is missing or uncapped — callers skip the
 *  count entirely, so a non-devin host never pays for the scan. */
export function devinSessionQuota(
  agents: Record<string, Record<string, unknown>> | undefined
): DevinSessionQuota | undefined {
  const bag = agents?.['devin']
  if (bag === undefined) {
    return undefined
  }
  const max = bag['maxSessions']
  const lockDir = typeof bag['lockDir'] === 'string' ? bag['lockDir'] : undefined
  const reservationsDir =
    typeof bag['reservationsDir'] === 'string' ? bag['reservationsDir'] : undefined
  if (max === undefined || max === 0) {
    // absent or an explicit 0 — the deliberate "off", same convention as
    // fleet.maxConcurrent
    return undefined
  }
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
    // the key exists — a typo silently disabling the guard is the worst
    // outcome; mark it so admission refuses with a config error
    return { maxSessions: 0, lockDir, reservationsDir, invalid: true }
  }
  return { maxSessions: max, lockDir, reservationsDir }
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
