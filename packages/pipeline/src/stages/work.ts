/**
 * The `work` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-qjji2.12) — the fleet slot's real worker spawn. The formula's
 * `work` stage declares `engine = "fleet"` with verdicts
 * `done|rate_limited|crash|stopped`; this factory is the
 * EngineHandler that binds it:
 *
 *   invoke  — build the FleetSpawnRequest from the call (item,
 *             route-stage ctx fields, fix scope, pipeline
 *             provenance), fire deps.spawn, then take ONE
 *             observation: live → 'pending' (the runner parks
 *             WITHOUT a verdict row — the spawn intent stays the
 *             resume anchor); already-terminal → settle in the same
 *             wake so an instant death never waits for a wake.
 *   recheck — observe only, NEVER re-fire: undefined attests "the
 *             spawn never landed" → the runner's bounded refire
 *             (attempt+1, go-marker re-consulted); live → 'pending';
 *             terminal → settle the pending record. The registry —
 *             not the journal — answers whether the side effect
 *             landed, which is what makes the verdict-less spawn
 *             intent safe to resume.
 *
 * Exit → taxonomy maps core's AgentInfo verbatim — `state` + `cause`
 * are the connector's classifyExitCauseParts output over the worker's
 * log tails; the engine classifies nothing itself:
 *
 *   spawned/running            → 'pending'
 *   stopped (operator `down`)  → stopped
 *   lost (dead, no record)     → crash
 *   exited/blocked, ok         → done
 *   exited/blocked, rate_limited|quota → rate_limited  (provider
 *     walls — deriveProviderWalls classes both; the verdict
 *     re-enters route's onWall path instead of burning the retry
 *     budget spawning into a wall)
 *   exited/blocked, crash|auth|absent → crash (worker-side failure —
 *     bounded retry, never a silent pass)
 *
 * Spawn refusals map the world, not the error text: SpawnError
 * 'cap' (the machine budget refused under the spawn lock — a
 * capacity wait, not a failure) answers the runner's capacity-wait
 * park (SATURATION_ALERT, resume = the stage) so a wake re-spawns
 * without burning an attempt — and NEVER 'rate_limited', which would
 * re-enter route's wall path and advance the provider chain past a
 * healthy lane. 'conflict' with a live observation attaches to the
 * worker already owning the step ('pending' — the fleet registry IS
 * the dedup plane); any other refusal propagates as the crash marker.
 *
 * Composition: the work stage's intent is 'spawn'
 * (STAGE_INTENTS.fleet) — a DEFAULT_ADMIT_INTENTS member, so the
 * runner consults the bound `admit` go-marker seam BEFORE invoke and
 * an admit EngineResult settles the stage without the engine firing.
 * Journaled occupancy (limits.in_flight, maxInFlight, stage
 * concurrency) is checked by the runner before the engine runs — the
 * engine implements no second semaphore.
 *
 * The payload keeps worker provenance NESTED under `worker` — flat
 * provider/model/class keys belong to route's payload and would flip
 * their meaning mid-pipeline (review's `reviewer` slot set the
 * precedent). `diff` rides `done` only: the provenance record the
 * accept stage's evidenceBundle lifts as its freshest `diff` field —
 * a crashed attempt's partial tree is not acceptance evidence.
 *
 * Injected seams keep the stage provider- and store-agnostic: `spawn`
 * fronts the fleet spawn facade (prod binds spawnStepAgent over the
 * agent-connectors seam — connector, provider, worktree, claim,
 * registry, caps all theirs); `observe` fronts the registry/connector
 * status read keyed by the item; `diff` fronts git over the worker's
 * recorded worktree.
 */
import {
  type AgentCause,
  type AgentInfo,
  type MaybePromise,
  type PipelineProvenance,
  SpawnError,
} from '@broject/core';
import {
  type EngineHandler,
  type EngineOutcome,
  SATURATION_ALERT,
  type StageCall,
} from '../runner.ts';
import { ORCH_MODES, type RouteOrch } from './route.ts';

/** The stage's declared verdicts — the formula's enum. */
export const WORK_VERDICTS = ['done', 'rate_limited', 'crash', 'stopped'] as const;
export type WorkVerdict = (typeof WORK_VERDICTS)[number];

/** What the fleet spawn seam is asked to launch — the item's fleet
 *  step plus everything the route stage journaled and the run's
 *  identity. The engine writes NO worker-facing text (spec invariant
 *  1): prompt composition belongs to the seam — on a scoped re-entry
 *  it renders `notes` into the fix instructions against the same
 *  recorded worktree. */
export interface FleetSpawnRequest {
  /** the fleet step — the item's bead id; the claim/dedup key
   *  (SpawnSpec.molStep). */
  molStep: string;
  /** the spawn lane — 'batch' default (pipeline work is fleet-owned
   *  batch work); deps.lane overrides. */
  lane: 'batch' | 'interactive';
  /** the route stage's journaled routing fields — present only when
   *  ctx carried a non-empty string (route's flat-merged payload). */
  provider?: string;
  model?: string;
  class?: string;
  /** the agent kind + orchestration surface route resolved — seam
   *  hints (session kind, spawn surface), not engine-resolved picks. */
  kind?: string;
  orch?: RouteOrch;
  /** scoped-fix re-entry — the runner's fix round + scope; the seam
   *  composes them into the worker's instructions. */
  fixRound?: number;
  notes?: string;
  /** formula provenance — lands in the registry (formula,
   *  formula_sha, pipeline_stage, session_id) and the BRO-Formula
   *  commit pin (SpawnSpec.pipeline). */
  pipeline?: PipelineProvenance;
}

/** Diff provenance the accept bundle lifts — a summary record
 *  ({files, base, head, worktree}), never the diff text: review's own
 *  diff seam reads the artifact. */
export interface FleetDiff {
  /** changed paths — names only */
  files?: string[];
  /** the diff base ref (merge-base / main head) */
  base?: string;
  /** the worktree head ref */
  head?: string;
  /** the worktree the diff was read from */
  worktree?: string;
}

/** The work stage's journaled payload — merges into the pipeline
 *  context flat AND under the stage name (`work`). */
export interface FleetPayload {
  /** the settled worker's registry provenance — NESTED so flat
   *  provider/model/class keys keep route's meaning (review's
   *  `reviewer` precedent). */
  worker?: {
    agentId?: string;
    backend?: string;
    provider?: string;
    model?: string;
    class?: string;
  };
  /** the worktree the worker ran in (the recorded checkout) */
  worktree?: string;
  /** the exit classification — core's AgentCause verbatim, absent on
   *  live/lost/unclassified observations */
  cause?: AgentCause;
  /** the provider-reported reset riding a rate_limited/quota cause */
  resetAt?: string;
  /** the scoped-fix round this work ran under — restated for journal
   *  readers (the row already carries fix_round) */
  fixRound?: number;
  /** diff provenance — `done` verdicts only, when the seam produced
   *  one; the accept bundle's freshest `diff` field */
  diff?: FleetDiff;
  /** the derived headline — a deterministic line off the observation */
  summary?: string;
}

export interface FleetDeps {
  /** fire the worker — prod binds the fleet spawn facade
   *  (spawnStepAgent over the agent-connectors seam: connector,
   *  provider, worktree, claim, registry, caps all theirs). Throws
   *  SpawnError on refusal; any other throw is the crash marker. */
  spawn(call: StageCall, req: FleetSpawnRequest): MaybePromise<AgentInfo>;
  /** the item's current worker — the registry/connector read keyed
   *  by molStep (= call.item). `undefined` attests DEFINITIVELY no
   *  worker (the spawn never landed → the runner's bounded refire);
   *  a READ FAILURE THROWS — an unreadable plane fails closed, never
   *  reads as absence. A superseding respawn's entry is the item's
   *  latest worker — its exit is the item's work verdict (the
   *  registry keeps the latest run per step). */
  observe(call: StageCall): MaybePromise<AgentInfo | undefined>;
  /** diff provenance after a `done` exit — prod binds git over the
   *  worker's recorded worktree. `undefined` journals no `diff` — a
   *  done worker that changed nothing is still done. */
  diff?(call: StageCall, worker: AgentInfo): MaybePromise<FleetDiff | undefined>;
  /** the formula's logical identity for spawn provenance —
   *  `formula@sha` lands in the registry + BRO-Formula trailer.
   *  `formulaSha` defaults to the run's journaled sha; absent `formula`
   *  means ad-hoc spawn (no provenance — never fabricated). */
  pipeline?: { formula: string; formulaSha?: string; sessionId?: string };
  /** spawn lane override — default 'batch' */
  lane?: 'batch' | 'interactive';
}

/** The routing fields route's payload flat-merges into ctx — strings
 *  only; anything else is not a routing answer and never reaches the
 *  spawn request. */
const ROUTING_CTX_KEYS = ['provider', 'model', 'class', 'kind', 'orch'] as const;

/** The run's journaled formula sha — every row carries it
 *  (RunOptions.formulaSha is required), so the first row for this run
 *  answers. Undefined only on a journal with no rows yet — invoke
 *  always runs after the intent append, recheck after the pending
 *  record, so real runs always resolve. */
function journaledSha(call: StageCall): string | undefined {
  for (const row of call.journal.rows()) {
    if (row.run_id === call.runId && row.formula_sha !== '') {
      return row.formula_sha;
    }
  }
  return undefined;
}

/** The PipelineProvenance for this spawn — deps identity + the
 *  journaled run sha. Absent `deps.pipeline.formula` or an
 *  unresolvable sha → undefined: provenance is never fabricated. */
function pipelineFor(call: StageCall, deps: FleetDeps): PipelineProvenance | undefined {
  const p = deps.pipeline;
  if (p === undefined) {
    return undefined;
  }
  const sha = p.formulaSha ?? journaledSha(call);
  if (sha === undefined) {
    return undefined;
  }
  return {
    formula: p.formula,
    formulaSha: sha,
    stage: call.stage.name,
    ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
  };
}

/** The spawn request — item as molStep, route's journaled fields,
 *  fix scope, provenance. `orch` validates against the route
 *  vocabulary; a ctx value outside it is not a routing answer. */
function spawnRequestFor(call: StageCall, deps: FleetDeps): FleetSpawnRequest {
  const req: FleetSpawnRequest = {
    molStep: call.item,
    lane: deps.lane ?? 'batch',
  };
  for (const key of ROUTING_CTX_KEYS) {
    const v = call.ctx[key];
    if (typeof v !== 'string' || v === '') {
      continue;
    }
    if (key === 'orch') {
      // the orch vocabulary is route's — a non-member never spawns
      // through an orch surface the formula doesn't declare
      if ((ORCH_MODES as readonly string[]).includes(v)) {
        req.orch = v as RouteOrch;
      }
      continue;
    }
    req[key] = v;
  }
  if (call.fixRound !== undefined) {
    req.fixRound = call.fixRound;
  }
  if (call.notes !== undefined) {
    req.notes = call.notes;
  }
  const pipe = pipelineFor(call, deps);
  if (pipe !== undefined) {
    req.pipeline = pipe;
  }
  return req;
}

/** A live worker can still change — 'pending' while the spawn/runs
 *  are in flight; everything else is a recorded or unrecorded death. */
const isLive = (obs: AgentInfo): boolean => obs.state === 'spawned' || obs.state === 'running';

/** The cause half of the exit taxonomy — core's AgentCause verbatim.
 *  `quota` rides `rate_limited`: deriveProviderWalls classes it a
 *  provider wall beside rate_limited, so the verdict re-enters
 *  route's onWall path (park until reset / fallthrough) rather than
 *  `crash → retry` spawning into a wall the chain should route
 *  around. `auth`/`crash`/unclassified are worker-side failures →
 *  crash: bounded retry, fail closed, never a silent pass. */
function causeVerdict(cause: AgentCause | undefined): WorkVerdict {
  if (cause === 'ok') {
    return 'done';
  }
  if (cause === 'rate_limited' || cause === 'quota') {
    return 'rate_limited';
  }
  return 'crash';
}

/** One observation → the stage's answer — 'pending' while live, else
 *  the declared verdict. `blocked` reads by cause like `exited`: the
 *  worker already died — the state only records that its wall still
 *  holds for respawn, and the rate_limited verdict hands the wait to
 *  route's chain. `lost` is a confirmed death with no record — the
 *  work outcome is unproven, so crash (bounded retry on the same
 *  recorded worktree) rather than a wait that can never produce one. */
function verdictFor(obs: AgentInfo): WorkVerdict | 'pending' {
  switch (obs.state) {
    case 'spawned':
    case 'running':
      return 'pending';
    case 'stopped':
      return 'stopped';
    case 'lost':
      return 'crash';
    case 'blocked':
    case 'exited':
      return causeVerdict(obs.cause);
  }
}

/** The deterministic headline — off the observation, never the seam. */
function summaryFor(verdict: WorkVerdict, obs: AgentInfo): string {
  const id = obs.id;
  switch (verdict) {
    case 'done':
      return `worker ${id} exited ok`;
    case 'rate_limited':
      return `worker ${id} hit a provider wall (${obs.cause ?? 'rate_limited'})`;
    case 'stopped':
      return `worker ${id} stopped`;
    case 'crash':
      return obs.state === 'lost'
        ? `worker ${id} lost — dead with no exit record`
        : `worker ${id} exited ${obs.cause ?? 'unclassified'}`;
  }
}

/** The typed payload — nested worker provenance, the exit cause,
 *  fix scope restated, and `diff` on `done` only (the accept
 *  bundle's freshest diff field; a crashed attempt's partial tree
 *  is not acceptance evidence — the retry's done diff covers the
 *  cumulative worktree anyway). */
async function payloadFor(
  call: StageCall,
  obs: AgentInfo,
  verdict: WorkVerdict,
  deps: FleetDeps
): Promise<FleetPayload> {
  const worker: NonNullable<FleetPayload['worker']> = {
    agentId: obs.id,
    backend: obs.backend,
  };
  if (obs.provider !== undefined) {
    worker.provider = obs.provider;
  }
  if (obs.model !== undefined) {
    worker.model = obs.model;
  }
  if (obs.class !== undefined) {
    worker.class = obs.class;
  }
  const p: FleetPayload = { worker, summary: summaryFor(verdict, obs) };
  if (obs.worktree !== undefined) {
    p.worktree = obs.worktree;
  }
  if (obs.cause !== undefined) {
    p.cause = obs.cause;
  }
  if (obs.resetAt !== undefined) {
    p.resetAt = obs.resetAt;
  }
  if (call.fixRound !== undefined) {
    p.fixRound = call.fixRound;
  }
  if (verdict === 'done' && deps.diff !== undefined) {
    const d = await deps.diff(call, obs);
    if (d !== undefined) {
      p.diff = d;
    }
  }
  return p;
}

/** The observation must be THIS item's worker — a seam answering
 *  another step's agent would settle the intent on foreign work;
 *  fail loud like every other untrustworthy seam answer. */
function checkItem(obs: AgentInfo, call: StageCall): void {
  if (obs.molStep !== call.item) {
    throw new Error(
      `work: the fleet seam returned agent "${obs.id}" for step ` +
        `"${obs.molStep}", not "${call.item}"`
    );
  }
}

/** One observation → 'pending' or the settling verdict+payload —
 *  the single mapper invoke's post-spawn read and recheck share. */
async function settle(call: StageCall, obs: AgentInfo, deps: FleetDeps): Promise<EngineOutcome> {
  checkItem(obs, call);
  const verdict = verdictFor(obs);
  if (verdict === 'pending') {
    return 'pending';
  }
  return { verdict, payload: await payloadFor(call, obs, verdict, deps) };
}

/** A spawn refusal → the world's answer, mapped by kind — never by
 *  message text. 'cap' is a capacity wait (the machine budget
 *  refused under the spawn lock after admission passed): the
 *  runner's capacity-wait park, resume = the stage — a wake
 *  re-enters and re-spawns, no attempt burned, and deliberately NOT
 *  'rate_limited' (that verdict re-enters route's wall path and
 *  would advance the provider chain past a healthy lane). 'conflict'
 *  with a live observation attaches to the worker already owning the
 *  step — this run's pending intent settles on ITS exit (the fleet
 *  registry IS the dedup plane; a claim-side refusal with no live
 *  worker, and every other kind, propagates as the crash marker). */
async function spawnRefusal(
  err: unknown,
  call: StageCall,
  deps: FleetDeps
): Promise<EngineOutcome> {
  if (err instanceof SpawnError) {
    if (err.kind === 'cap') {
      return { alert: SATURATION_ALERT, detail: err.message };
    }
    if (err.kind === 'conflict') {
      const live = await deps.observe(call);
      if (live !== undefined && isLive(live)) {
        return settle(call, live, deps);
      }
    }
  }
  throw err;
}

/**
 * The work stage as an EngineHandler for the runner's `fleet` slot —
 * spawn the item's worker through the fleet seam, map the recorded
 * exit onto done|rate_limited|crash|stopped, journal the diff
 * provenance the accept bundle signs. `recheck` observes only: a
 * verdict-less spawn intent re-fires bounded when no worker exists,
 * parks while one runs, and settles on its recorded exit — the
 * go-marker + registry dedup make the re-fire safe.
 */
export function workStage(deps: FleetDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineOutcome> {
      const req = spawnRequestFor(call, deps);
      let worker: AgentInfo;
      try {
        worker = await deps.spawn(call, req);
      } catch (err) {
        return spawnRefusal(err, call, deps);
      }
      // one post-spawn read settles an instant death in the same wake;
      // a seam that can't see its own spawn yet falls back to the
      // spawn's own AgentInfo (state 'spawned' → pending either way)
      const obs = (await deps.observe(call)) ?? worker;
      return settle(call, obs, deps);
    },
    async recheck(call: StageCall): Promise<EngineOutcome | undefined> {
      const obs = await deps.observe(call);
      if (obs === undefined) {
        return undefined; // spawn never landed — bounded refire attested
      }
      return settle(call, obs, deps);
    },
  };
}
