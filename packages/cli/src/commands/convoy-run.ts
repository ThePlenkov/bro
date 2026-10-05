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
}

const TERMINAL: ReadonlySet<AgentState> = new Set(['exited', 'lost', 'stopped', 'blocked'])
/** Status probes failing in a row before the worker is treated as
 *  gone — a flaky backend must not wedge the queue forever. */
const STATUS_FAIL_LIMIT = 10

const sleepWall = (sec: number): Promise<void> =>
  new Promise((r) => setTimeout(r, sec * 1000))

const isoEta = (ms: number): string =>
  ms >= 3600_000 ? `${Math.round(ms / 3600_00) / 10}h` : ms >= 60_000 ? `${Math.ceil(ms / 60_000)}m` : `${Math.ceil(ms / 1000)}s`

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
  const why =
    cause === 'quota'
      ? 'quota exhausted'
      : cause === 'rate_limited'
        ? 'rate_limited — provider reported no reset'
        : (cause ?? 'blocked')
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

/** One molecule end-to-end: spawn → await → classify → respawn, until
 *  the mol completes, the attempts cap lands, or a wait/park verdict
 *  decides. */
export async function runMol(
  deps: RunDeps,
  cfg: RunArgs,
  molId: string
): Promise<MolResult> {
  let attempts = 0
  for (;;) {
    let mol: Molecule
    try {
      mol = deps.loadMol(molId)
    } catch (err) {
      return {
        mol: molId,
        verdict: 'error',
        attempts,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
    const before = deps.next(mol)
    if (before.state === 'complete') {
      return { mol: molId, verdict: 'done', attempts }
    }
    if (before.state === 'gate') {
      return { mol: molId, verdict: 'gated', attempts, detail: before.gates.join(', ') }
    }

    let agent: AgentInfo
    try {
      agent = await deps.spawn(molId)
    } catch (err) {
      if (!(err instanceof SpawnError)) {
        return {
          mol: molId,
          verdict: 'error',
          attempts,
          detail: err instanceof Error ? err.message : String(err),
        }
      }
      // a refusal is a signal — the registry re-read says which kind:
      // blocked → the wall path; live entry → another worker owns the
      // mol; a full fleet cap → capacity, wait a tick, no attempt
      const e = deps.entry(molId)
      if (e !== undefined && agentEntryBlocked(e, deps.now())) {
        const d = blockedDecision(e, e.cause as string | undefined, e.resetAt as string | undefined, deps)
        if ('parked' in d) {
          return { mol: molId, verdict: 'parked', attempts, detail: d.parked }
        }
        deps.say(`run ${molId}: rate_limited until reset — waiting ${isoEta(d.waitSec * 1000)}`)
        await deps.sleepSec(d.waitSec)
        continue
      }
      if (e !== undefined) {
        const st = deps.entryState(e)
        if (st === 'running' || st === 'spawned') {
          return {
            mol: molId,
            verdict: 'occupied',
            attempts,
            detail: `${err.message}`,
          }
        }
        if (st === 'stopped') {
          return { mol: molId, verdict: 'stopped', attempts }
        }
      }
      if (deps.fleetFull()) {
        deps.say(`run ${molId}: fleet cap full — waiting a poll tick`)
        await deps.sleepSec(cfg.pollSec)
        continue
      }
      attempts += 1
      if (attempts >= cfg.attempts) {
        return { mol: molId, verdict: 'failed', attempts, detail: err.message }
      }
      deps.say(`run ${molId}: spawn refused (${err.message}) — attempt ${attempts}`)
      await deps.sleepSec(cfg.retryDelaySec)
      continue
    }

    deps.say(`run ${molId}: agent ${agent.id} up — polling`)
    const last = await pollAgent(deps, cfg, agent)

    let after: ConvoyNext
    try {
      after = deps.next(deps.loadMol(molId))
    } catch (err) {
      return {
        mol: molId,
        verdict: 'error',
        attempts,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
    if (after.state === 'complete') {
      return { mol: molId, verdict: 'done', attempts: attempts + 1 }
    }
    if (after.state === 'gate') {
      return { mol: molId, verdict: 'gated', attempts: attempts + 1, detail: after.gates.join(', ') }
    }
    if (last.state === 'blocked') {
      const d = blockedDecision(deps.entry(molId), last.cause, last.resetAt, deps)
      if ('parked' in d) {
        return { mol: molId, verdict: 'parked', attempts: attempts + 1, detail: d.parked }
      }
      deps.say(`run ${molId}: ${last.cause} until ${last.resetAt} — waiting ${isoEta(d.waitSec * 1000)}`)
      await deps.sleepSec(d.waitSec)
      continue
    }
    if (last.state === 'stopped') {
      return { mol: molId, verdict: 'stopped', attempts: attempts + 1 }
    }
    attempts += 1
    if (attempts >= cfg.attempts) {
      return {
        mol: molId,
        verdict: 'failed',
        attempts,
        detail: `agent ${last.state}${last.cause === undefined ? '' : ` (${last.cause})`}, mol incomplete`,
      }
    }
    deps.say(`run ${molId}: agent ${last.state} with mol incomplete — attempt ${attempts}`)
    await deps.sleepSec(cfg.retryDelaySec)
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
    results.push(await runMol(deps, cfg, molId))
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
  }

  const results = await runQueue(deps, cfg)
  let failed = 0
  for (const r of results) {
    if (cfg.json) {
      console.log(JSON.stringify(r))
    } else {
      console.log(`run ${r.mol} ${r.verdict}${r.detail === undefined ? '' : ` — ${r.detail}`}`)
    }
    if (r.verdict === 'failed' || r.verdict === 'error') {
      failed += 1
    }
  }
  say(`run: queue drained — ${results.length - failed}/${results.length} settled`)
  if (failed > 0) {
    process.exitCode = 1
  }
}
