/**
 * `bro convoy run` — the molecule queue runner: the bro-native
 * replacement for the hand-rolled `/tmp/mol-queue2.sh` driver
 * (spec: specs/bro-7xgk.4.md).
 *
 *   bro convoy run <mol>…             each molecule to 'complete', one at a time
 *   bro convoy run --open             every open molecule, pour order
 *   bro convoy run --attempts N       per-mol attempt cap (4)
 *   bro convoy run --poll SEC         agent state poll interval (15)
 *   bro convoy run --retry-delay SEC  spacing between crash retries (60)
 *   bro convoy run --json             one JSON verdict line per mol
 *
 * Sequential like the script it replaces — the inference-budget wall is
 * why this epic exists; fleet.maxConcurrent still bounds the fleet at
 * the spawn prologue. Each mol spawns a convoy-runner agent through the
 * facade keyed on the molecule ROOT bead — the registry pins
 * {pid, log, prompt, exit} so `bro agents status`/`bro fleet`/`bro
 * watch` see the worker the script used to hide, and the exit-cause
 * taxonomy decides what a death means: rate_limited waits for the
 * provider's reset, stopped is an operator verdict (never respawned),
 * crashes retry bounded by --attempts.
 */
import {
  agentEntryBlocked,
  agentRegistryPath,
  AgentNotFound,
  facade,
  loadConfig,
  readAgentRegistry,
  SpawnError,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
} from '@broject/core'
import {
  beadsDir,
  listMolecules,
  loadMolecule,
  nextStep,
  type ConvoyNext,
  type Molecule,
} from '@broject/convoy'
import {
  fleetCapOf,
  fleetOccupancyFor,
  loadAgentEnv,
  resolveAgentConnector,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { flag, positionals } from './args.ts'
import { spawnStepAgent } from './agents.ts'
import { registryEntryState } from './drive.ts'
import { mainWorktree } from './work.ts'
import { dirname, join } from 'node:path'

// --- args ------------------------------------------------------------------------

export interface RunArgs {
  mols: string[]
  open: boolean
  attempts: number
  pollSec: number
  retryDelaySec: number
  json: boolean
}

const RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--attempts',
  '--poll',
  '--retry-delay',
])

const numFlag = (argv: string[], name: string, dflt: number): number => {
  const raw = flag(argv, name)
  if (raw === undefined) {
    return dflt
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    console.error(`error: ${name} needs a value >= 1, got "${raw}"`)
    process.exit(2)
  }
  return n
}

export function runArgs(argv: string[]): RunArgs {
  return {
    mols: positionals(argv, RUN_VALUE_FLAGS),
    open: argv.includes('--open'),
    attempts: numFlag(argv, '--attempts', 4),
    pollSec: numFlag(argv, '--poll', 15),
    retryDelaySec: numFlag(argv, '--retry-delay', 60),
    json: argv.includes('--json'),
  }
}

/** The flags `run` understands — the dispatcher's unknown-option check
 *  reads this so a misspelled flag can't silently degrade a run. */
export const RUN_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...RUN_VALUE_FLAGS,
  '--open',
  '--json',
])

// --- prompt ------------------------------------------------------------------------

/** The convoy-runner work order — mol-queue2.sh's prompt verbatim in
 *  spirit: work the molecule's steps in order to 'complete', merge is
 *  the worker's, dead-session claims get released and re-claimed. */
export function runnerPrompt(molId: string, repo: string): string {
  return [
    `Run the convoy for molecule ${molId}. Use the convoy skill (skills/convoy/SKILL.md):`,
    `\`bro convoy next --mol ${molId}\`, claim steps, work them in order — including`,
    'Verify and Merge steps (merge is yours: `bro act merge` refuses on a non-green',
    'gate, keep fixing/deferring until it merges). If a step is already claimed by a',
    'dead session, release it (`bd update <step> --status open`) and claim it yourself.',
    `Work in ${repo} — create your worktree via the work skill. If the bead references`,
    "a spec, read it from specs/ first. Run the molecule to 'state: complete' — do NOT",
    'stop at gates you can settle yourself; a real human gate means exit cleanly and',
    'let the runner report the mol gated.',
  ].join('\n')
}

// --- the runner ------------------------------------------------------------------------

export type MolVerdict =
  | 'done' // mol reached 'complete'
  | 'gated' // a human gate is pending — reported, never worked past
  | 'occupied' // a live worker/session owns the mol — skip, never double-work
  | 'stopped' // operator `bro agents down` — never respawn a manual stop
  | 'parked' // a budget wall with no advertised end (quota / no-reset rate limit)
  | 'blocked' // a closed dependency loop — 'complete' is unreachable, a worker can't fix it
  | 'failed' // attempts exhausted
  | 'error' // the mol or its probes could not be read

export interface MolResult {
  mol: string
  verdict: MolVerdict
  attempts: number
  detail?: string
}

/** Everything the loop needs, injectable — tests drive the whole
 *  classification matrix without a repo, a backend, or real sleeps. */
export interface RunDeps {
  loadMol: (id: string) => Molecule
  next: (mol: Molecule) => ConvoyNext
  listOpen: () => { id: string }[]
  spawn: (molId: string) => Promise<AgentInfo>
  status: (agentId: string) => Promise<AgentInfo>
  /** The molStep's registry entry — the refusal classifier reads it. */
  entry: (molId: string) => AgentRegistryEntry | undefined
  /** Registry-only liveness for a refusal-time entry (cheap, no probes). */
  entryState: (entry: AgentRegistryEntry) => AgentState
  /** Fleet occupancy at refusal time — a full cap is a wait, not a fail. */
  fleetFull: () => boolean
  sleepSec: (sec: number) => Promise<void>
  now: () => number
  say: (msg: string) => void
  /** Fires the moment a mol settles 'gated' — the human alert is the
   *  gate's whole point; it cannot wait for the rest of the sequential
   *  queue to drain. */
  onGated?: (r: MolResult) => Promise<void>
}

const TERMINAL: ReadonlySet<AgentState> = new Set(['exited', 'lost', 'stopped', 'blocked'])
/** Status probes failing in a row before the worker is treated as
 *  gone — a flaky backend must not wedge the queue forever. */
const STATUS_FAIL_LIMIT = 10

const sleepWall = (sec: number): Promise<void> =>
  new Promise((r) => setTimeout(r, sec * 1000))

const isoEta = (ms: number): string => {
  if (ms >= 3_600_000) {
    return `${Math.round(ms / 360_000) / 10}h`
  }
  if (ms >= 60_000) {
    return `${Math.ceil(ms / 60_000)}m`
  }
  return `${Math.ceil(ms / 1000)}s`
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The blocked-entry decision: a rate limit with a provider reset is a
 *  wait (sleep until it, respawn, no attempt burned); every other block
 *  is a parked mol — a wall with no advertised end gets reported, not
 *  waited into, and `bro agents down` stays the manual escape. Cause
 *  and reset resolve AgentInfo-first with the registry entry (the same
 *  record agentEntryBlocked reads) as fallback. */
function blockedDecision(
  entry: AgentRegistryEntry | undefined,
  infoCause: string | undefined,
  infoResetAt: string | undefined,
  deps: RunDeps
): { waitSec: number } | { parked: string } {
  const cause = infoCause ?? (entry?.cause as string | undefined)
  const resetAt = infoResetAt ?? (entry?.resetAt as string | undefined)
  const reset = typeof resetAt === 'string' ? Date.parse(resetAt) : Number.NaN
  if (cause === 'rate_limited' && !Number.isNaN(reset)) {
    return { waitSec: Math.max(1, Math.ceil((reset - deps.now()) / 1000)) }
  }
  let why = cause ?? 'blocked'
  if (cause === 'quota') {
    why = 'quota exhausted'
  } else if (cause === 'rate_limited') {
    why = 'rate_limited — provider reported no reset'
  }
  return { parked: `${why} — \`bro agents down\` clears the block` }
}

/** Poll the spawned agent until it goes terminal. A status() throw is
 *  transient until STATUS_FAIL_LIMIT in a row — then the worker is
 *  unverifiable, which reads as 'lost' (never 'running' on faith). */
async function pollAgent(
  deps: RunDeps,
  cfg: RunArgs,
  agent: AgentInfo
): Promise<AgentInfo> {
  let failures = 0
  for (;;) {
    await deps.sleepSec(cfg.pollSec)
    let s: AgentInfo
    try {
      s = await deps.status(agent.id)
    } catch (err) {
      if (err instanceof AgentNotFound) {
        return { ...agent, state: 'lost' }
      }
      failures += 1
      if (failures >= STATUS_FAIL_LIMIT) {
        return { ...agent, state: 'lost' }
      }
      continue
    }
    if (TERMINAL.has(s.state)) {
      return s
    }
    failures = 0
  }
}

/** A loop step's outcome: a settled mol, a timed wait (no attempt
 *  burned), or a burned attempt to retry after. */
type RunStep = MolResult | { waitSec: number } | { retry: true }

const isResult = (s: RunStep): s is MolResult => 'verdict' in s
const isWait = (s: RunStep): s is { waitSec: number } => 'waitSec' in s

/** A mol with a permanently-blocked step can never reach 'complete' —
 *  every blocker sits in a closed loop, so no amount of worker effort
 *  closes it. Report the defect instead of spawning into it. Waits on
 *  open work (in-progress claims, external deps) stay spawns — claims
 *  are claims, not proof of liveness, and a worker can release them. */
function dagVerdict(n: ConvoyNext, molId: string, attempts: number): MolResult | undefined {
  if (n.stuck.length === 0) {
    return undefined
  }
  return {
    mol: molId,
    verdict: 'blocked',
    attempts,
    detail: `dependency cycle: ${n.stuck.join(', ')}`,
  }
}

/** The pre-spawn read: load + next. Returns the ConvoyNext to act on,
 *  or a MolResult when the mol already settles the run (complete, a
 *  pending human gate, unreadable). */
function precheck(deps: RunDeps, molId: string, attempts: number): ConvoyNext | MolResult {
  let mol: Molecule
  try {
    mol = deps.loadMol(molId)
  } catch (err) {
    return { mol: molId, verdict: 'error', attempts, detail: errText(err) }
  }
  const n = deps.next(mol)
  if (n.state === 'complete') {
    return { mol: molId, verdict: 'done', attempts }
  }
  if (n.state === 'gate') {
    return { mol: molId, verdict: 'gated', attempts, detail: n.gates.join(', ') }
  }
  return dagVerdict(n, molId, attempts) ?? n
}

/** A spawn refusal is a signal, not a verdict. The error's kind is the
 *  thrower's own word when it knows (cap → capacity — wait a tick, no
 *  attempt); the registry re-read classifies the rest: a blocked entry
 *  takes the wall path, a live entry means another worker owns the mol,
 *  a stopped one is the operator's verdict. What remains is a bare
 *  refusal — it burns an attempt. */
function refusalOutcome(
  deps: RunDeps,
  cfg: RunArgs,
  molId: string,
  err: SpawnError,
  attempts: number
): RunStep {
  if (err.kind === 'cap') {
    deps.say(`run ${molId}: fleet cap full — waiting a poll tick`)
    return { waitSec: cfg.pollSec }
  }
  const e = deps.entry(molId)
  if (e !== undefined && agentEntryBlocked(e, deps.now())) {
    const d = blockedDecision(e, e.cause as string | undefined, e.resetAt as string | undefined, deps)
    if ('parked' in d) {
      return { mol: molId, verdict: 'parked', attempts, detail: d.parked }
    }
    deps.say(`run ${molId}: rate_limited until reset — waiting ${isoEta(d.waitSec * 1000)}`)
    return d
  }
  if (e !== undefined) {
    const st = deps.entryState(e)
    if (st === 'running' || st === 'spawned') {
      return { mol: molId, verdict: 'occupied', attempts, detail: err.message }
    }
    if (st === 'stopped') {
      return { mol: molId, verdict: 'stopped', attempts }
    }
  }
  // an untyped refusal while the fleet reads full is capacity — same
  // wait, just classified by occupancy instead of the kind
  if (deps.fleetFull()) {
    deps.say(`run ${molId}: fleet cap full — waiting a poll tick`)
    return { waitSec: cfg.pollSec }
  }
  const spent = attempts + 1
  if (spent >= cfg.attempts) {
    return { mol: molId, verdict: 'failed', attempts: spent, detail: err.message }
  }
  deps.say(`run ${molId}: spawn refused (${err.message}) — attempt ${spent}`)
  return { retry: true }
}

/** The terminal-state classification: re-read the mol first — its
 *  state outranks the agent's (a worker that died after finishing
 *  still counts done). Then the agent's own terminal state decides:
 *  blocked → the wall path, stopped → the operator verdict, anything
 *  else with the mol still open → a burned attempt. */
function afterRun(
  deps: RunDeps,
  cfg: RunArgs,
  molId: string,
  last: AgentInfo,
  attempts: number
): RunStep {
  const spent = attempts + 1
  let after: ConvoyNext
  try {
    after = deps.next(deps.loadMol(molId))
  } catch (err) {
    return { mol: molId, verdict: 'error', attempts: spent, detail: errText(err) }
  }
  if (after.state === 'complete') {
    return { mol: molId, verdict: 'done', attempts: spent }
  }
  if (after.state === 'gate') {
    return { mol: molId, verdict: 'gated', attempts: spent, detail: after.gates.join(', ') }
  }
  const dag = dagVerdict(after, molId, spent)
  if (dag !== undefined) {
    return dag
  }
  if (last.state === 'blocked') {
    const d = blockedDecision(deps.entry(molId), last.cause, last.resetAt, deps)
    if ('parked' in d) {
      return { mol: molId, verdict: 'parked', attempts: spent, detail: d.parked }
    }
    deps.say(`run ${molId}: ${last.cause} until ${last.resetAt} — waiting ${isoEta(d.waitSec * 1000)}`)
    return d
  }
  if (last.state === 'stopped') {
    return { mol: molId, verdict: 'stopped', attempts: spent }
  }
  if (spent >= cfg.attempts) {
    const cause = last.cause === undefined ? '' : ` (${last.cause})`
    return {
      mol: molId,
      verdict: 'failed',
      attempts: spent,
      detail: `agent ${last.state}${cause}, mol incomplete`,
    }
  }
  deps.say(`run ${molId}: agent ${last.state} with mol incomplete — attempt ${spent}`)
  return { retry: true }
}

/** mol-queue2.sh's fast-fail ramp: an agent dead under ~300s never did
 *  real work — a crash loop gets 900/1800/3600s spacing, doubling per
 *  consecutive fast exit, capped at an hour-ish. A slow crash did work
 *  and resets the streak — it pays the flat --retry-delay. */
const FAST_FAIL_MS = 300_000
const BACKOFF_BASE_SEC = 900
const BACKOFF_CAP_SEC = 3600

const backoffSec = (streak: number): number =>
  Math.min(BACKOFF_BASE_SEC * 2 ** (streak - 1), BACKOFF_CAP_SEC)

/** Agent lifetime for the fast-fail check — the registry-stamped
 *  spawnedAt when the backend reports it, else the spawn call's start. */
const agentLivedMs = (deps: RunDeps, spawnedAtMs: number, last: AgentInfo): number => {
  const born = Date.parse(last.spawnedAt ?? '')
  return deps.now() - (Number.isNaN(born) ? spawnedAtMs : born)
}

/** One spawn → poll → classify cycle of the mol loop: the step to act
 *  on, the delay the fast-fail streak earned, and the updated streak.
 *  A SpawnError lands as the refusal-classified step; anything else as
 *  an error result — both flow back through the caller's RunStep
 *  checks unchanged. */
async function molAttempt(
  deps: RunDeps,
  cfg: RunArgs,
  molId: string,
  attempts: number,
  fastFails: number
): Promise<{ step: RunStep; delaySec: number; fastFails: number }> {
  let step: RunStep
  let delaySec = cfg.retryDelaySec
  try {
    const t0 = deps.now()
    const agent = await deps.spawn(molId)
    deps.say(`run ${molId}: agent ${agent.id} up — polling`)
    const last = await pollAgent(deps, cfg, agent)
    step = afterRun(deps, cfg, molId, last, attempts)
    if ('retry' in step) {
      fastFails = agentLivedMs(deps, t0, last) < FAST_FAIL_MS ? fastFails + 1 : 0
      if (fastFails > 0) {
        delaySec = backoffSec(fastFails)
        deps.say(`run ${molId}: fast exit #${fastFails} — respawn in ${isoEta(delaySec * 1000)}`)
      }
    }
  } catch (err) {
    step =
      err instanceof SpawnError
        ? refusalOutcome(deps, cfg, molId, err, attempts)
        : { mol: molId, verdict: 'error', attempts, detail: errText(err) }
  }
  return { step, delaySec, fastFails }
}

/** One molecule end-to-end: spawn → await → classify → respawn, until
 *  the mol completes, the attempts cap lands, or a wait/park verdict
 *  decides. */
export async function runMol(
  deps: RunDeps,
  cfg: RunArgs,
  molId: string
): Promise<MolResult> {
  let attempts = 0
  let fastFails = 0
  for (;;) {
    const pre = precheck(deps, molId, attempts)
    if ('verdict' in pre) {
      return pre
    }
    const attempt = await molAttempt(deps, cfg, molId, attempts, fastFails)
    const { step, delaySec } = attempt
    fastFails = attempt.fastFails
    if (isResult(step)) {
      return step
    }
    if (isWait(step)) {
      await deps.sleepSec(step.waitSec)
      continue
    }
    attempts += 1
    await deps.sleepSec(delaySec)
  }
}

/** The HUMAN GATE moment — a mol that reached a human step exists
 *  precisely so a person hears about it. Publishes through the events
 *  facade so `notify.sinks` webhooks see it (spec: specs/bro-huy5o.8.md);
 *  the keyed event also coalesces repeat sightings on the mailbox.
 *  Fail-open like every emit — a gate report never stalls the runner. */
export async function publishGate(dir: string, molId: string, detail: string): Promise<void> {
  try {
    await facade('events', { dir }, { prefer: loadConfig(dir).connectors }).publish({
      topic: 'convoy',
      kind: 'gate',
      key: `convoy-gate-${molId}`,
      source: 'convoy',
      payload:
        `convoy ${molId}: HUMAN GATE ready` +
        (detail === '' ? '' : ` — ${detail}`) +
        ' — human input needed',
    })
  } catch {
    // fail-open — sinks/mailbox are advisory edges, never a runner failure
  }
}

/** The queue: each mol in order, sequential like the script it
 *  replaces. Returns the per-mol verdicts; the caller renders. */
export async function runQueue(
  deps: RunDeps,
  cfg: RunArgs
): Promise<MolResult[]> {
  const ids = [...cfg.mols]
  if (cfg.open) {
    for (const m of deps.listOpen()) {
      if (!ids.includes(m.id)) {
        ids.push(m.id)
      }
    }
  }
  const results: MolResult[] = []
  for (const molId of ids) {
    const r = await runMol(deps, cfg, molId)
    if (r.verdict === 'gated') {
      await deps.onGated?.(r)
    }
    results.push(r)
  }
  return results
}

// --- the command ------------------------------------------------------------------------

/** Registry-only entry reads for the refusal classifier — home is the
 *  agents dir beside agents.json (same derivation drive's
 *  registryAgents uses). */
function entryOps(dir: string): Pick<RunDeps, 'entry' | 'entryState'> {
  const regPath = agentRegistryPath(dir)
  const home = regPath === null ? null : join(dirname(regPath), 'agents')
  return {
    entry: (molId) => (regPath === null ? undefined : readAgentRegistry(dir)[molId]),
    entryState: (e) => registryEntryState(home, e),
  }
}

export async function runConvoyRun(argv: string[]): Promise<void> {
  const cfg = runArgs(argv)
  const ids = cfg.mols.length + (cfg.open ? 1 : 0)
  if (ids === 0) {
    console.error('error: run needs molecule ids or --open')
    process.exit(2)
  }
  const main = mainWorktree()
  const dir = main.path
  const env: AgentConnectorEnv = loadAgentEnv(dir)
  const conn: AgentConnector = resolveAgentConnector({ dir }, {}, env)
  const beads = beadsDir()

  const say = (msg: string): void => {
    if (cfg.json) {
      console.error(msg)
    } else {
      console.log(msg)
    }
  }
  const deps: RunDeps = {
    loadMol: loadMolecule,
    next: nextStep,
    listOpen: listMolecules,
    spawn: (molId) =>
      spawnStepAgent(dir, env, {
        molStep: molId,
        worktree: dir,
        prompt: runnerPrompt(molId, dir),
        beadsDir: beads,
      }),
    status: (id) => conn.status(id),
    ...entryOps(dir),
    fleetFull: () => {
      const cap = fleetCapOf(env)
      return cap > 0 && fleetOccupancyFor(dir, env) >= cap
    },
    sleepSec: sleepWall,
    now: () => Date.now(),
    say,
    onGated: (r) => publishGate(dir, r.mol, r.detail ?? ''),
  }

  const results = await runQueue(deps, cfg)
  let failed = 0
  for (const r of results) {
    if (cfg.json) {
      console.log(JSON.stringify(r))
    } else {
      const detail = r.detail === undefined ? '' : ` — ${r.detail}`
      console.log(`run ${r.mol} ${r.verdict}${detail}`)
    }
    if (r.verdict === 'failed' || r.verdict === 'error' || r.verdict === 'blocked') {
      failed += 1
    }
  }
  say(`run: queue drained — ${results.length - failed}/${results.length} settled`)
  if (failed > 0) {
    process.exitCode = 1
  }
}
