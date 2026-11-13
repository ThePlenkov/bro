/** `convoyPolicy` — the convoy runner as a rig policy (bro-u6fp5,
 *  spec bro-u6fp5.md). Moved verbatim from `commands/convoy-run.ts` —
 *  the runMol/runQueue FSM was already dependency-injected (`RunDeps`:
 *  "tests drive the whole classification matrix without a repo, a
 *  backend, or real sleeps"), so this is a move, not a rewrite. The
 *  command keeps argv parsing, deps wiring, and output; the policy
 *  owns select/onGate/onPark/onLost — the lifecycle moments the FSM
 *  hits:
 *
 *    select  — the queue pick (cfg.mols order, --open merged)
 *    onGate  — a mol whose next.state is 'gate' settles 'gated'
 *    onPark  — a provider wall with no advertised end settles 'parked'
 *    onLost  — the worker's terminal/refused classification: wall
 *              wait, 'parked'/'stopped'/'occupied'/'failed', or a
 *              'retry'/'wait' RunStep
 *
 *  'done'/'blocked'/'error' are mol-state terminal verdicts the driver
 *  returns directly — success/cycle/unreadable are not the four named
 *  transitions. `run`/`runQueue` ride along as the policy's own driver
 *  (the per-item FSM and the sequential queue) — the Policy interface
 *  names lifecycle moments; the driver is the policy's engine. */
import {
  AgentNotFound,
  agentEntryBlocked,
  SpawnError,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
} from '@broject/core';
import type { ConvoyNext, Molecule } from '@broject/convoy';
import type { Policy } from '../policy.ts';

// --- args/config -------------------------------------------------------------------

export interface RunArgs {
  mols: string[];
  open: boolean;
  attempts: number;
  pollSec: number;
  retryDelaySec: number;
  json: boolean;
}

// --- the injectable IO surface ------------------------------------------------------

export type MolVerdict =
  | 'done' // mol reached 'complete'
  | 'gated' // a human gate is pending — reported, never worked past
  | 'occupied' // a live worker/session owns the mol — skip, never double-work
  | 'stopped' // operator `bro agents down` — never respawn a manual stop
  | 'parked' // a budget wall with no advertised end (quota / no-reset rate limit)
  | 'blocked' // a closed dependency loop — 'complete' is unreachable, a worker can't fix it
  | 'failed' // attempts exhausted
  | 'error'; // the mol or its probes could not be read

export interface MolResult {
  mol: string;
  verdict: MolVerdict;
  attempts: number;
  detail?: string;
  /** Set when this settle tripped the infra streak (bro-zaydc): the
   *  queue must stop here — the remaining mols are reported 'parked'
   *  untouched, never spawned into a dead spawn boundary. */
  queueStop?: boolean;
}

/** Everything the loop needs, injectable — tests drive the whole
 *  classification matrix without a repo, a backend, or real sleeps. */
export interface RunDeps {
  loadMol: (id: string) => Molecule;
  next: (mol: Molecule) => ConvoyNext;
  listOpen: () => { id: string }[];
  spawn: (molId: string) => Promise<AgentInfo>;
  status: (agentId: string) => Promise<AgentInfo>;
  /** The molStep's registry entry — the refusal classifier reads it. */
  entry: (molId: string) => AgentRegistryEntry | undefined;
  /** Registry-only liveness for a refusal-time entry (cheap, no probes). */
  entryState: (entry: AgentRegistryEntry) => AgentState;
  /** Fleet occupancy at refusal time — a full cap is a wait, not a fail. */
  fleetFull: () => boolean;
  sleepSec: (sec: number) => Promise<void>;
  now: () => number;
  say: (msg: string) => void;
  /** Fires the moment a mol settles 'gated' — the human alert is the
   *  gate's whole point; it cannot wait for the rest of the sequential
   *  queue to drain. */
  onGated?: (r: MolResult) => Promise<void>;
  /** Fires the moment a mol settles 'parked' (quota/wall with no reset). */
  onParked?: (r: MolResult) => Promise<void>;
  /** Fires the moment a mol settles 'stopped' (operator down). */
  onStopped?: (r: MolResult) => Promise<void>;
  /** Fires the moment a mol settles 'failed' (attempts exhausted). */
  onFailed?: (r: MolResult) => Promise<void>;
}

/** The policy's world — the injected deps plus the run knobs, and the
 *  select() cursor the queue driver seeds. */
export interface ConvoyCtx {
  deps: RunDeps;
  cfg: RunArgs;
  /** The mol ids select() pops — runQueue seeds it from cfg.mols +
   *  --open before the first pick. */
  queue?: string[];
  /** Consecutive work-boundary failures that produced no worker — the
   *  infra-streak circuit breaker (spec bro-zaydc). */
  infraStreak?: number;
}

/** One molecule under the policy — the driver's record. `attempts`
 *  counts completed failed attempts; a worker classification reports
 *  the in-flight count (attempts+1) on a snapshot item, matching the
 *  verdict semantics the serial loop always had. `agent`/`refusal`
 *  carry the worker situation onLost classifies — exactly one is set
 *  per call. `next` is the last computed step state onGate reads. */
export interface ConvoyItem {
  /** The molecule root bead id. */
  mol: string;
  /** Completed failed attempts — the --attempts bound counts these. */
  attempts: number;
  /** Consecutive fast-fail exits — the backoff ramp's streak. */
  fastFails: number;
  /** The last computed ConvoyNext — gate verdicts read its gates. */
  next?: ConvoyNext;
  /** The terminal agent — set on the afterRun classification path. */
  agent?: AgentInfo;
  /** The spawn refusal — set on the refusalOutcome classification path. */
  refusal?: SpawnError;
}

// --- the FSM currency ----------------------------------------------------------------

/** A loop step's outcome: a settled mol, a timed wait (no attempt
 *  burned), or a burned attempt to retry after. */
type RunStep = MolResult | { waitSec: number } | { retry: true };

const isResult = (s: RunStep): s is MolResult => 'verdict' in s;
const isWait = (s: RunStep): s is { waitSec: number } => 'waitSec' in s;

const TERMINAL: ReadonlySet<AgentState> = new Set(['exited', 'lost', 'stopped', 'blocked']);
/** Status probes failing in a row before the worker is treated as
 *  gone — a flaky backend must not wedge the queue forever. */
const STATUS_FAIL_LIMIT = 10;
/** Consecutive spawn-level failures with zero attempts before the
 *  queue stops (spec bro-zaydc) — a dead bro binary, a wedged claim
 *  store, a missing multiplexer. Under the limit the mol holds a poll
 *  tick and retries (the cu3q8 hold, bounded); at the limit the streak
 *  is the outage's proof and the queue parks instead of draining one
 *  'error' per mol. */
const INFRA_FAIL_LIMIT = 3;

const isoEta = (ms: number): string => {
  if (ms >= 3_600_000) {
    return `${Math.round(ms / 360_000) / 10}h`;
  }
  if (ms >= 60_000) {
    return `${Math.ceil(ms / 60_000)}m`;
  }
  return `${Math.ceil(ms / 1000)}s`;
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  const cause = infoCause ?? (entry?.cause as string | undefined);
  const resetAt = infoResetAt ?? (entry?.resetAt as string | undefined);
  const reset = typeof resetAt === 'string' ? Date.parse(resetAt) : Number.NaN;
  if (cause === 'rate_limited' && !Number.isNaN(reset)) {
    return { waitSec: Math.max(1, Math.ceil((reset - deps.now()) / 1000)) };
  }
  let why = cause ?? 'blocked';
  if (cause === 'quota') {
    why = 'quota exhausted';
  } else if (cause === 'rate_limited') {
    why = 'rate_limited — provider reported no reset';
  }
  return { parked: `${why} — \`bro agents down\` clears the block` };
}

/** Poll the spawned agent until it goes terminal. A status() throw is
 *  transient until STATUS_FAIL_LIMIT in a row — then the worker is
 *  unverifiable, which reads as 'lost' (never 'running' on faith). */
async function pollAgent(ctx: ConvoyCtx, agent: AgentInfo): Promise<AgentInfo> {
  let failures = 0;
  for (;;) {
    await ctx.deps.sleepSec(ctx.cfg.pollSec);
    let s: AgentInfo;
    try {
      s = await ctx.deps.status(agent.id);
    } catch (err) {
      if (err instanceof AgentNotFound) {
        return { ...agent, state: 'lost' };
      }
      failures += 1;
      if (failures >= STATUS_FAIL_LIMIT) {
        return { ...agent, state: 'lost' };
      }
      continue;
    }
    if (TERMINAL.has(s.state)) {
      return s;
    }
    failures = 0;
  }
}

/** A mol with a permanently-blocked step can never reach 'complete' —
 *  every blocker sits in a closed loop, so no amount of worker effort
 *  closes it. Report the defect instead of spawning into it. Waits on
 *  open work (in-progress claims, external deps) stay spawns — claims
 *  are claims, not proof of liveness, and a worker can release them. */
function dagVerdict(n: ConvoyNext, molId: string, attempts: number): MolResult | undefined {
  if (n.stuck.length === 0) {
    return undefined;
  }
  return {
    mol: molId,
    verdict: 'blocked',
    attempts,
    detail: `dependency cycle: ${n.stuck.join(', ')}`,
  };
}

// --- the Policy ---------------------------------------------------------------------

/** The convoy runner's lifecycle decisions — select/onGate/onPark/
 *  onLost over `ConvoyItem`/`ConvoyCtx`, verdicts as `RunStep` (a
 *  settled MolResult, a timed wait, or a retry). The verbs are sync —
 *  the classification reads already-resolved state; the signatures
 *  narrow the Policy union (no Promise) and pin the verdict shapes the
 *  FSM consumes: gate/park always settle a MolResult, onLost is the
 *  only verb that can answer a wait or a retry. */
export interface ConvoyPolicy extends Policy<ConvoyItem, ConvoyCtx, RunStep> {
  select(ctx: ConvoyCtx): ConvoyItem | undefined;
  onGate(ctx: ConvoyCtx, item: ConvoyItem): MolResult;
  onPark(ctx: ConvoyCtx, item: ConvoyItem, why: string): MolResult;
  onLost(ctx: ConvoyCtx, item: ConvoyItem): RunStep;
  /** The per-item FSM driver — precheck → spawn → poll → classify,
   *  until a terminal MolResult. Policy-specific: the four Policy
   *  verbs are the lifecycle moments; this is the item's own engine. */
  run(ctx: ConvoyCtx, item: ConvoyItem): Promise<MolResult>;
  /** The queue driver — select each item, run it to a verdict, fire
   *  the settle hooks. Sequential like the script it replaces. */
  runQueue(ctx: ConvoyCtx): Promise<MolResult[]>;
}

export const convoyPolicy: ConvoyPolicy = {
  /** select — the next mol in queue order; undefined drains. */
  select(ctx) {
    const mol = ctx.queue?.shift();
    return mol === undefined ? undefined : { mol, attempts: 0, fastFails: 0 };
  },

  /** onGate — the mol sits at a human gate: settle 'gated', never
   *  spawn past it. `item.next` is the ConvoyNext that proved it. */
  onGate(_ctx, item) {
    return {
      mol: item.mol,
      verdict: 'gated',
      attempts: item.attempts,
      detail: (item.next?.gates ?? []).join(', '),
    };
  },

  /** onPark — a wall with no advertised end: report 'parked' with the
   *  wall detail; `bro agents down` is the manual escape. */
  onPark(_ctx, item, why) {
    return { mol: item.mol, verdict: 'parked', attempts: item.attempts, detail: why };
  },

  /** onLost — the worker situation resolved without work: a refused
   *  spawn (`item.refusal`) or a terminal agent (`item.agent`). The
   *  classification is the exit-cause taxonomy — rate_limited with a
   *  reset waits it out (no attempt burned), quota/no-reset parks,
   *  stopped is the operator verdict, a live entry means occupied,
   *  attempts exhausted fails, anything else retries. */
  onLost(ctx, item) {
    if (item.refusal !== undefined) {
      return refusalStep(ctx, item, item.refusal);
    }
    return agentLostStep(ctx, item, item.agent!);
  },

  async run(ctx, item) {
    return runItem(ctx, item);
  },

  async runQueue(ctx) {
    const ids = [...ctx.cfg.mols];
    if (ctx.cfg.open) {
      for (const m of ctx.deps.listOpen()) {
        if (!ids.includes(m.id)) {
          ids.push(m.id);
        }
      }
    }
    ctx.queue = ids;
    const results: MolResult[] = [];
    for (;;) {
      const item = convoyPolicy.select(ctx);
      if (item === undefined) {
        break;
      }
      const r = await convoyPolicy.run(ctx, item); // NOSONAR — a convoy runs its mols in order, never fanned out
      if (r.verdict === 'gated') {
        await ctx.deps.onGated?.(r); // NOSONAR — serial by contract
      } else if (r.verdict === 'parked') {
        await ctx.deps.onParked?.(r);
      } else if (r.verdict === 'stopped') {
        await ctx.deps.onStopped?.(r);
      } else if (r.verdict === 'failed') {
        await ctx.deps.onFailed?.(r);
      }
      results.push(r);
      if (r.queueStop === true) {
        // the infra streak tripped — park the rest of the queue
        // untouched; a dead spawn boundary must not be fed mol after
        // mol (spec bro-zaydc)
        const why = r.detail ?? 'infra down';
        ctx.deps.say(`run: queue stopped — ${why}`);
        for (const mol of ctx.queue ?? []) {
          const parked: MolResult = {
            mol,
            verdict: 'parked',
            attempts: 0,
            detail: `queue stopped — ${why}`,
          };
          await ctx.deps.onParked?.(parked); // NOSONAR — serial by contract
          results.push(parked);
        }
        break;
      }
    }
    return results;
  },
};

/** The infra streak's increment — consecutive work-boundary failures
 *  that produced no worker (spec bro-zaydc). */
const bumpInfra = (ctx: ConvoyCtx): number => (ctx.infraStreak = (ctx.infraStreak ?? 0) + 1);

/** A spawn throw that produced no worker and no classified answer —
 *  'unavailable'/'config'/'input' SpawnError kinds (the taxonomy's
 *  non-work classes — the loop refuses to burn fix rounds on the same
 *  set) or any unclassified throw (spawnSync timeout, ENOENT, a wedged
 *  store, SpawnInputError — in the convoy shape every mol spawns into
 *  the same worktree/config, so these are systemic). Under
 *  INFRA_FAIL_LIMIT the mol holds a poll tick and retries — no attempt
 *  burned: attempts counts workers, and no worker ever existed. At the
 *  limit the mol settles 'error' flagged queueStop — the queue parks
 *  the rest instead of draining. */
function infraFail(ctx: ConvoyCtx, item: ConvoyItem, why: string): RunStep {
  const streak = bumpInfra(ctx);
  if (streak >= INFRA_FAIL_LIMIT) {
    return {
      mol: item.mol,
      verdict: 'error',
      attempts: item.attempts,
      detail: `${why} — infra down (${streak} consecutive spawn-level failures)`,
      queueStop: true,
    };
  }
  ctx.deps.say(
    `run ${item.mol}: spawn-level failure ${streak}/${INFRA_FAIL_LIMIT} — ${why} — ` +
      `retry in ${ctx.cfg.pollSec}s`
  );
  return { waitSec: ctx.cfg.pollSec };
}

/** A zero-attempt read failure — the mol or its probes could not be
 *  read (a stalled store hits loadMol/next before spawn is ever
 *  reached). The mol settles 'error' immediately — a permanent miss
 *  must not pay the infra retries, and post-run a worker may be live
 *  (never a blind re-spawn) — but it still counts the streak: K in a
 *  row trips the same queueStop. */
function infraSettle(ctx: ConvoyCtx, item: ConvoyItem, spent: number, why: string): MolResult {
  const streak = bumpInfra(ctx);
  const stop = streak >= INFRA_FAIL_LIMIT;
  return {
    mol: item.mol,
    verdict: 'error',
    attempts: spent,
    detail: stop ? `${why} — infra down (${streak} consecutive spawn-level failures)` : why,
    ...(stop ? { queueStop: true as const } : {}),
  };
}

/** The spawn-refusal half of onLost — a SpawnError is a signal, not a
 *  verdict. The error's kind is the thrower's own word when it knows
 *  (cap → capacity — wait a tick, no attempt); the registry re-read
 *  classifies the rest: a blocked entry takes the wall path, a live
 *  entry means another worker owns the mol, a stopped one is the
 *  operator's verdict. What remains is a bare refusal — it burns an
 *  attempt. */
function refusalStep(ctx: ConvoyCtx, item: ConvoyItem, err: SpawnError): RunStep {
  const { deps, cfg } = ctx;
  if (err.kind === 'cap') {
    ctx.infraStreak = 0; // a classified refusal — the machinery answered
    deps.say(`run ${item.mol}: fleet cap full — waiting a poll tick`);
    return { waitSec: cfg.pollSec };
  }
  // infra-class kinds produce no worker and no per-mol answer — the
  // streak owns them (unavailable/config/input are systemic in the
  // convoy shape: one shared worktree/config for every mol's spawn)
  if (err.kind === 'unavailable' || err.kind === 'config' || err.kind === 'input') {
    return infraFail(ctx, item, err.message);
  }
  ctx.infraStreak = 0; // 'conflict'/untyped — the machinery answered
  const e = deps.entry(item.mol);
  if (e !== undefined && agentEntryBlocked(e, deps.now())) {
    const d = blockedDecision(
      e,
      e.cause as string | undefined,
      e.resetAt as string | undefined,
      deps
    );
    if ('parked' in d) {
      return convoyPolicy.onPark(ctx, item, d.parked);
    }
    deps.say(`run ${item.mol}: rate_limited until reset — waiting ${isoEta(d.waitSec * 1000)}`);
    return d;
  }
  if (e !== undefined) {
    const st = deps.entryState(e);
    if (st === 'running' || st === 'spawned') {
      return { mol: item.mol, verdict: 'occupied', attempts: item.attempts, detail: err.message };
    }
    if (st === 'stopped') {
      return { mol: item.mol, verdict: 'stopped', attempts: item.attempts };
    }
  }
  // an untyped refusal while the fleet reads full is capacity — same
  // wait, just classified by occupancy instead of the kind
  if (deps.fleetFull()) {
    deps.say(`run ${item.mol}: fleet cap full — waiting a poll tick`);
    return { waitSec: cfg.pollSec };
  }
  const spent = item.attempts + 1;
  if (spent >= cfg.attempts) {
    return { mol: item.mol, verdict: 'failed', attempts: spent, detail: err.message };
  }
  deps.say(`run ${item.mol}: spawn refused (${err.message}) — attempt ${spent}`);
  return { retry: true };
}

/** The terminal-agent half of onLost — re-read the mol first: its
 *  state outranks the agent's (a worker that died after finishing
 *  still counts done — handled by afterRun before this is reached).
 *  Then the agent's own terminal state decides: blocked → the wall
 *  path, stopped → the operator verdict, anything else with the mol
 *  still open → a burned attempt. */
function agentLostStep(ctx: ConvoyCtx, item: ConvoyItem, last: AgentInfo): RunStep {
  const { deps, cfg } = ctx;
  const spent = item.attempts + 1;
  if (last.state === 'blocked') {
    const d = blockedDecision(deps.entry(item.mol), last.cause, last.resetAt, deps);
    if ('parked' in d) {
      return convoyPolicy.onPark(ctx, { ...item, attempts: spent }, d.parked);
    }
    deps.say(
      `run ${item.mol}: ${last.cause} until ${last.resetAt} — waiting ${isoEta(d.waitSec * 1000)}`
    );
    return d;
  }
  if (last.state === 'stopped') {
    return { mol: item.mol, verdict: 'stopped', attempts: spent };
  }
  if (spent >= cfg.attempts) {
    const cause = last.cause === undefined ? '' : ` (${last.cause})`;
    return {
      mol: item.mol,
      verdict: 'failed',
      attempts: spent,
      detail: `agent ${last.state}${cause}, mol incomplete`,
    };
  }
  deps.say(`run ${item.mol}: agent ${last.state} with mol incomplete — attempt ${spent}`);
  return { retry: true };
}

/** The pre-spawn read: load + next. Returns the ConvoyNext to act on,
 *  or a MolResult when the mol already settles the run (complete, a
 *  pending human gate, unreadable, a closed dependency loop). */
function precheck(ctx: ConvoyCtx, item: ConvoyItem): ConvoyNext | MolResult {
  let n: ConvoyNext;
  try {
    n = ctx.deps.next(ctx.deps.loadMol(item.mol));
  } catch (err) {
    return infraSettle(ctx, item, item.attempts, errText(err));
  }
  item.next = n;
  if (n.state === 'complete') {
    return { mol: item.mol, verdict: 'done', attempts: item.attempts };
  }
  if (n.state === 'gate') {
    return convoyPolicy.onGate(ctx, item);
  }
  return dagVerdict(n, item.mol, item.attempts) ?? n;
}

/** The terminal-state classification: re-read the mol first — its
 *  state outranks the agent's (a worker that died after finishing
 *  still counts done). Then the agent's own terminal state decides —
 *  onLost owns that half (blocked → wall path, stopped → operator
 *  verdict, else a burned attempt). */
function afterRun(ctx: ConvoyCtx, item: ConvoyItem): RunStep {
  const spent = item.attempts + 1;
  let after: ConvoyNext;
  try {
    after = ctx.deps.next(ctx.deps.loadMol(item.mol));
  } catch (err) {
    return infraSettle(ctx, item, spent, errText(err));
  }
  item.next = after;
  if (after.state === 'complete') {
    return { mol: item.mol, verdict: 'done', attempts: spent };
  }
  if (after.state === 'gate') {
    return convoyPolicy.onGate(ctx, { ...item, attempts: spent });
  }
  const dag = dagVerdict(after, item.mol, spent);
  if (dag !== undefined) {
    return dag;
  }
  return convoyPolicy.onLost(ctx, item);
}

/** mol-queue2.sh's fast-fail ramp: an agent dead under ~300s never did
 *  real work — a crash loop gets 900/1800/3600s spacing, doubling per
 *  consecutive fast exit, capped at an hour-ish. A slow crash did work
 *  and resets the streak — it pays the flat --retry-delay. */
const FAST_FAIL_MS = 300_000;
const BACKOFF_BASE_SEC = 900;
const BACKOFF_CAP_SEC = 3600;

const backoffSec = (streak: number): number =>
  Math.min(BACKOFF_BASE_SEC * 2 ** (streak - 1), BACKOFF_CAP_SEC);

/** Agent lifetime for the fast-fail check — the registry-stamped
 *  spawnedAt when the backend reports it, else the spawn call's start. */
const agentLivedMs = (deps: RunDeps, spawnedAtMs: number, last: AgentInfo): number => {
  const born = Date.parse(last.spawnedAt ?? '');
  return deps.now() - (Number.isNaN(born) ? spawnedAtMs : born);
};

/** One spawn → poll → classify cycle of the mol loop: the step to act
 *  on, the delay the fast-fail streak earned, and the updated streak
 *  (kept on the item). A SpawnError lands as the onLost refusal
 *  classification; anything else as an error result — both flow back
 *  through the caller's RunStep checks unchanged. */
async function molAttempt(
  ctx: ConvoyCtx,
  item: ConvoyItem
): Promise<{ step: RunStep; delaySec: number }> {
  let step: RunStep;
  let delaySec = ctx.cfg.retryDelaySec;
  try {
    const t0 = ctx.deps.now();
    const agent = await ctx.deps.spawn(item.mol);
    // a resolved spawn proves the machinery answered — the outage
    // streak only counts throws that produced no worker (bro-zaydc)
    ctx.infraStreak = 0;
    ctx.deps.say(`run ${item.mol}: agent ${agent.id} up — polling`);
    const last = await pollAgent(ctx, agent);
    step = afterRun(ctx, { ...item, agent: last });
    if ('retry' in step) {
      item.fastFails = agentLivedMs(ctx.deps, t0, last) < FAST_FAIL_MS ? item.fastFails + 1 : 0;
      if (item.fastFails > 0) {
        delaySec = backoffSec(item.fastFails);
        ctx.deps.say(
          `run ${item.mol}: fast exit #${item.fastFails} — respawn in ${isoEta(delaySec * 1000)}`
        );
      }
    }
  } catch (err) {
    step =
      err instanceof SpawnError
        ? convoyPolicy.onLost(ctx, { ...item, refusal: err })
        : infraFail(ctx, item, errText(err));
  }
  return { step, delaySec };
}

/** One molecule end-to-end: spawn → await → classify → respawn, until
 *  the mol completes, the attempts cap lands, or a wait/park verdict
 *  decides. */
async function runItem(ctx: ConvoyCtx, item: ConvoyItem): Promise<MolResult> {
  for (;;) {
    const pre = precheck(ctx, item);
    if ('verdict' in pre) {
      return pre;
    }
    const { step, delaySec } = await molAttempt(ctx, item);
    if (isResult(step)) {
      return step;
    }
    if (isWait(step)) {
      await ctx.deps.sleepSec(step.waitSec);
      continue;
    }
    item.attempts += 1;
    await ctx.deps.sleepSec(delaySec);
  }
}

// --- driver entry points ---------------------------------------------------------------

/** One molecule end-to-end — the runMol signature the command and the
 *  tests already speak. */
export async function runMol(deps: RunDeps, cfg: RunArgs, molId: string): Promise<MolResult> {
  return convoyPolicy.run({ deps, cfg }, { mol: molId, attempts: 0, fastFails: 0 });
}

/** The queue: each mol in order, sequential like the script it
 *  replaces. Returns the per-mol verdicts; the caller renders. */
export async function runQueue(deps: RunDeps, cfg: RunArgs): Promise<MolResult[]> {
  return convoyPolicy.runQueue({ deps, cfg });
}
