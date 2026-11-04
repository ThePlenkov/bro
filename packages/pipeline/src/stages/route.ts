/**
 * The `route` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-7d5nb.4) — G2 routing. One item, one decide(): the judge reads
 * the bead + the fleet's load and answers typed questions the core
 * interprets into the stage's verdict enum:
 *
 *   defer — an operator should look at this item  → park
 *   queue — wait: saturation, judge timing, wall  → park
 *   spawn — route now                             → work
 *
 * The payload the runner absorbs into the pipeline context:
 * `{class, kind, orch, timing, provider?, model?}` — the judge emits
 * the routing fields (class/kind/orch/timing); `provider`/`model` are
 * RESOLVED through `fleet.routing.<class>.chain`, never named by core
 * and never picked by the judge — the router answers *which lane*,
 * the table owns the chain (same split as the M7 fleet router).
 *
 * `work`'s `rate_limited` verdict re-enters route: the journal — the
 * runner's own durable record — shows a settled route payload followed
 * by a rate_limited death. That re-entry is DETERMINISTIC, not
 * re-judged: `fleet.routing.<class>.onWall` decides — `park` answers
 * `queue` (the wall is waited out parked), `fallthrough` dispatches
 * the next un-walled chain entry (`queue` when the chain is spent).
 * The routing fields stay the journaled ones; only provider/model
 * move.
 *
 * Injected seams keep the stage provider- and store-agnostic: `judge`
 * is the JudgeFacade decide path; `backlog` fronts the task store for
 * the item read + the `class:` label write; `routing` + `providers`
 * bind `fleet.routing` resolution through the same `resolveStepClass`
 * the spawn lanes use; `occupancy` fronts the occupancy plane
 * (fleetOccupancyFor in prod) and `walls` fronts derived provider
 * walls (deriveProviderWalls in prod). Nothing here branches on a
 * provider name — names are chain DATA, the logic walks indexes.
 */
import type {
  DecideResult,
  JudgeAnswer,
  JudgeFacade,
  JudgeQuestion,
  ProviderEntry,
  ProviderWall,
  ResolvedClass,
  RoutingClass,
  RoutingTable,
  TaskRow,
} from '@broject/core';
import { CLASS_LABEL_PREFIX, resolveStepClass } from '@broject/core';
import { journalRecords, type JournalRow } from '../journal.ts';
import type { EngineHandler, EngineResult, StageCall } from '../runner.ts';

/** `orch` — the orchestration lane the spec declares (acp session /
 *  foreground run / exec spawn). Enum-shaped like classify's defer
 *  reasons: the answer is a code, never prose. */
export const ORCH_MODES = ['acp', 'foreground', 'exec'] as const;
export type RouteOrch = (typeof ORCH_MODES)[number];

/** `timing` — spawn now or park until capacity opens. */
export const ROUTE_TIMINGS = ['now', 'queue'] as const;
export type RouteTiming = (typeof ROUTE_TIMINGS)[number];

/** `kind` when the judge never named one and no kinds are declared —
 *  the unrouted lane name, same role as `default` on the class axis. */
export const DEFAULT_ROUTE_KIND = 'default';
/** `orch` when the judge is silent — the plainest spawn surface: a
 *  detached exec run needs no session attach and no pane, so an
 *  unrouted item takes the lane with the fewest prerequisites. */
export const DEFAULT_ROUTE_ORCH: RouteOrch = 'exec';

/** `queue` payload reason codes — which input parked the item. */
export const QUEUE_REASONS = {
  /** occupancy cap reached — the lane is full */
  saturated: 'saturated',
  /** the judge's own `timing` answer said queue */
  timing: 'timing',
  /** the class's `onWall` policy answered a wall with `park` */
  onwall: 'onwall',
  /** `onWall = "fallthrough"` with no un-walled entry left in the chain */
  chainSpent: 'chain-spent',
} as const;
export type QueueReason = (typeof QUEUE_REASONS)[keyof typeof QUEUE_REASONS];

/** The stage's typed payload (spec §typed stage outputs) — merged
 *  into the pipeline context flat AND under `route`. */
export interface RoutePayload {
  class: string;
  kind: string;
  orch: RouteOrch;
  timing: RouteTiming;
  /** resolved chain slot — present whenever a lane was resolved
   *  (queue carries it too: the wake re-dispatches it). */
  provider?: string;
  model?: string;
  /** queue verdicts only — which input parked the item */
  reason?: QueueReason;
  /** the wall a re-entry routed around — provider + derived cause */
  wall?: { provider: string; cause: string };
  /** question ids left under-confidence — telemetry, dimmed answers
   *  were not honored */
  lowConfidence?: string[];
}

/** The task-store seam — route reads the item and writes its `class:`
 *  lane pin. Structurally satisfied by classify's ClassifyBacklog, so
 *  prod can bind the same `taskBacklog(taskStore(dir))`. */
export interface RouteBacklog {
  item(id: string): TaskRow | undefined;
  addLabel(id: string, label: string): void;
  removeLabel(id: string, label: string): void;
}

/** The occupancy-plane snapshot — `live` agents against the fleet cap.
 *  `cap` absent/0 = uncapped (saturated never fires); prod binds
 *  `fleetOccupancyFor(dir, env)` as `live` and `fleet.maxConcurrent`
 *  as `cap`. A bare number from the seam reads as `{live: n}` —
 *  uncapped. */
export interface RouteLoad {
  live: number;
  cap?: number;
}

export interface RouteDeps {
  judge: JudgeFacade;
  backlog: RouteBacklog;
  /** `fleet.routing` — the class lanes. Required non-empty: a route
   *  stage with no declared lanes cannot emit a class. */
  routing: RoutingTable;
  /** `providers` — the map `resolveStepClass` validates chain entries
   *  against (a chain naming an unconfigured provider is a config
   *  error naming class + key, same as the spawn lanes). */
  providers: Record<string, ProviderEntry>;
  /** agent kinds the judge may pick — declared by the caller (the
   *  `agents.<kind>` keys in prod). Absent/empty → the kind question
   *  is skipped and the payload carries `default`. */
  kinds?: readonly string[];
  /** occupancy-plane snapshot — feeds the judge's load signal AND the
   *  deterministic saturation guard. Absent → no cap (never
   *  saturated, load state omitted). */
  occupancy?: () => RouteLoad | number;
  /** derived provider walls — prod binds `deriveProviderWalls` over
   *  the agents registry. Absent → nothing reads as walled. */
  walls?: () => ProviderWall[];
  /** write the `class:` label — default true */
  labels?: boolean;
}

/** The wall that sent a run back through route — a `rate_limited`
 *  work death after the last settled route. */
interface WallHit {
  /** the settled route payload the death followed — its class/kind/
   *  orch stand, only provider/model move */
  prev: RoutePayload;
  /** index into the resolved chain the death landed on — `0` when the
   *  journaled provider drifted out of the table (dispatch starts at
   *  chain[1]: the head is what a first spawn tries). */
  chainIndex: number;
  /** the wall recorded for the payload — provider + cause */
  wall: { provider: string; cause: string };
}

/** Invocation context — one bag keeps the helpers under the arg
 *  ceiling (same Checks-pattern as classify). */
interface Cx {
  deps: RouteDeps;
  itemId: string;
  item: TaskRow;
  res: DecideResult;
  load: RouteLoad | undefined;
  walled: Set<string>;
}

/** An answer the chain left under-confidence is unread — dim intake
 *  signals never route. */
const confident = (res: DecideResult, qid: string): boolean =>
  Object.hasOwn(res.answers, qid) && !res.lowConfidence.includes(qid);

const answer = (res: DecideResult, qid: string): JudgeAnswer | undefined =>
  Object.hasOwn(res.answers, qid) ? res.answers[qid] : undefined;

const choiceOf = (res: DecideResult, qid: string): string | undefined => {
  const a = answer(res, qid);
  return a?.type === 'choice' ? a.choice : undefined;
};

const noulOf = (res: DecideResult, qid: string): number | undefined => {
  const a = answer(res, qid);
  return a?.type === 'noul' ? a.noul : undefined;
};

/** noul ≥ this means the judge affirms the yes/no question. */
const AFFIRM = 0.5;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isOrch = (v: unknown): v is RouteOrch =>
  typeof v === 'string' && (ORCH_MODES as readonly string[]).includes(v);

/** The judge-visible item — bead fields only, trimmed to what routing
 *  judges on (same read shape as classify's rowView). */
const rowView = (r: TaskRow): Record<string, unknown> => ({
  id: r.id,
  title: r.title,
  description: r.description,
  labels: r.labels,
  priority: r.priority,
  parent: r.parent,
  status: r.status,
});

// --- the decide -----------------------------------------------------------------

/** `class` — a `choice` over exactly the declared lanes; the criteria
 *  list each class's provider chain so the judge picks a lane, never
 *  a provider (the M7 router's same contract). defineProperty per key
 *  — a '__proto__' class lands as an own key, same guard as
 *  fleetRouting's build. */
const classQuestion = (routing: RoutingTable): JudgeQuestion => {
  const criteria: Record<string, string> = {};
  for (const [cls, row] of Object.entries(routing)) {
    const chain = row.chain
      .map(e => (e.model === undefined ? e.provider : `${e.provider}(${e.model})`))
      .join(' → ');
    Object.defineProperty(criteria, cls, {
      value: `spawn chain: ${chain}`,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    type: 'choice',
    instructions:
      'Assign this work item to a routing class — the lane its work fits best. ' +
      'Each class names a lane; the criterion lists the provider chain a spawn on it lands on.',
    criteria,
  };
};

const kindQuestion = (kinds: readonly string[]): JudgeQuestion => {
  const criteria: Record<string, string> = {};
  for (const k of kinds) {
    Object.defineProperty(criteria, k, {
      value: `the "${k}" agent kind`,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    type: 'choice',
    instructions:
      'Which agent kind should run this item — the worker lane its shape fits ' +
      '(harness capabilities, not the provider: the class already picked the chain).',
    criteria,
  };
};

const orchQuestion = (): JudgeQuestion => ({
  type: 'choice',
  instructions: 'How should the item be orchestrated when it spawns?',
  criteria: {
    acp: 'attach a managed session — the worker runs under protocol supervision',
    foreground: 'a visible foreground run — the session surface owns it',
    exec: 'a detached exec spawn — the batch lane, no session attach',
  },
});

const timingQuestion = (): JudgeQuestion => ({
  type: 'choice',
  instructions:
    'Should the item spawn now or park until capacity opens? The state carries the ' +
    'fleet load — queue when the lane is saturated or the item can afford to wait.',
  criteria: {
    now: 'dispatch immediately — capacity is open or the item outranks the wait',
    queue: 'park it — the lane is saturated or later capacity serves it better',
  },
});

const deferQuestion = (): JudgeQuestion => ({
  type: 'noul',
  instructions:
    'Probability that routing this item needs an operator — no lane fits, the ' +
    'class/kind choice is genuinely ambiguous, or a human should decide where it runs.',
});

/** One decide's worth of questions — class/kind/orch/timing + the
 *  operator-defer noul, batched so the backends evaluate them in
 *  parallel. Domain vocabulary only: work items and lanes, never
 *  pipeline mechanics. `kind` is asked only when kinds are declared —
 *  a choice question with empty criteria is a malformed ask. */
function routeQuestions(deps: RouteDeps): Record<string, JudgeQuestion> {
  const q: Record<string, JudgeQuestion> = {
    class: classQuestion(deps.routing),
    orch: orchQuestion(),
    timing: timingQuestion(),
    defer: deferQuestion(),
  };
  if (deps.kinds !== undefined && deps.kinds.length > 0) {
    q.kind = kindQuestion(deps.kinds);
  }
  return q;
}

/** The judge-visible state — bead fields + the fleet's load, trimmed
 *  to what routing judges on. `walls` names the currently-walled
 *  providers so the judge sees which lanes' chains are already dead
 *  before picking a class — names are data, never logic inputs. */
const stateFor = (
  item: TaskRow,
  load: RouteLoad | undefined,
  walls: ProviderWall[]
): Record<string, unknown> => ({
  item: rowView(item),
  ...(load === undefined ? {} : { load }),
  ...(walls.length === 0
    ? {}
    : { walledProviders: walls.map(w => ({ provider: w.provider, cause: w.cause })) }),
});

// --- the pick -------------------------------------------------------------------

/** Confident class pick, or undefined — a confident answer outside
 *  the criteria is malformed (never a new class), and an unanswered
 *  or dimmed one delegates to `resolveStepClass`'s static fallbacks
 *  (the `default` lane), the same floor the spawn paths use. */
function classOf(cx: Cx): string | undefined {
  const pick = confident(cx.res, 'class') ? choiceOf(cx.res, 'class') : undefined;
  return pick !== undefined && Object.hasOwn(cx.deps.routing, pick) ? pick : undefined;
}

/** Confident kind pick — must name a declared kind. Unanswered → the
 *  first declared kind, else `default`: a kind the caller never
 *  declared is never invented. */
function kindOf(cx: Cx): string {
  const kinds = cx.deps.kinds ?? [];
  const pick = confident(cx.res, 'kind') ? choiceOf(cx.res, 'kind') : undefined;
  if (pick !== undefined && kinds.includes(pick)) {
    return pick;
  }
  return kinds[0] ?? DEFAULT_ROUTE_KIND;
}

/** Confident orch pick — unanswered → the declared default lane. */
function orchOf(cx: Cx): RouteOrch {
  const pick = confident(cx.res, 'orch') ? choiceOf(cx.res, 'orch') : undefined;
  return isOrch(pick) ? pick : DEFAULT_ROUTE_ORCH;
}

/** The deferred arm — an affirmed operator-defer noul. */
function deferred(cx: Cx): boolean {
  return confident(cx.res, 'defer') && (noulOf(cx.res, 'defer') ?? 0) >= AFFIRM;
}

/** The judged timing — 'queue' only on a confident queue; an
 *  unanswered/dimmed answer reads 'now': the occupancy seam is the
 *  deterministic guard, so silence never manufactures a park. */
function judgedTiming(cx: Cx): RouteTiming {
  return confident(cx.res, 'timing') && choiceOf(cx.res, 'timing') === 'queue' ? 'queue' : 'now';
}

const loadFor = (deps: RouteDeps): RouteLoad | undefined => {
  if (deps.occupancy === undefined) {
    return undefined;
  }
  const l = deps.occupancy();
  return typeof l === 'number' ? { live: l } : l;
};

/** Deterministic saturation — the judge's `timing` is advisory, the
 *  occupancy cap is not: a spawn verdict into a full lane would land
 *  on the same refusal the cap exists to pre-empt. */
const saturated = (load: RouteLoad | undefined): boolean =>
  load?.cap !== undefined && load.cap > 0 && load.live >= load.cap;

// --- chain dispatch ---------------------------------------------------------------

interface Dispatch {
  verdict: 'spawn' | 'queue';
  provider?: string;
  model?: string;
  reason?: QueueReason;
}

const spawned = (e: { provider: string; model?: string }): Dispatch =>
  e.model === undefined
    ? { verdict: 'spawn', provider: e.provider }
    : { verdict: 'spawn', provider: e.provider, model: e.model };

/** Where a routing lands given the walls — `onWall` is the class's
 *  declared answer to a walled lane: `park` queues on the spot,
 *  `fallthrough` walks to the next un-walled entry and queues only
 *  when the chain is spent. `start` is the chain index to try first —
 *  0 on a fresh route, one past the died-on provider on a wall
 *  re-entry. Provider names stay data — the walk is index arithmetic. */
function dispatch(resolved: ResolvedClass, start: number, walled: Set<string>): Dispatch {
  const head = resolved.chain[Math.max(0, start)];
  if (head !== undefined && !walled.has(head.provider)) {
    return spawned(head);
  }
  if (resolved.onWall === 'park' || head === undefined) {
    return {
      verdict: 'queue',
      reason: resolved.onWall === 'park' ? QUEUE_REASONS.onwall : QUEUE_REASONS.chainSpent,
    };
  }
  for (let i = Math.max(0, start) + 1; i < resolved.chain.length; i++) {
    const e = resolved.chain[i];
    if (!walled.has(e.provider)) {
      return spawned(e);
    }
  }
  return { verdict: 'queue', reason: QUEUE_REASONS.chainSpent };
}

// --- wall re-entry ----------------------------------------------------------------

/** A journaled route payload usable as the re-entry base — `class`
 *  must name a lane; anything else (foreign producer, drifted shape)
 *  is no anchor and the call falls back to a fresh decide. */
const routePayloadOf = (v: unknown): RoutePayload | undefined =>
  isRecord(v) && typeof v.class === 'string' ? (v as unknown as RoutePayload) : undefined;

/** The journal evidence for a wall re-entry — the last settled route
 *  payload for THIS stage plus whether a settled `rate_limited` on a
 *  spawn intent followed it with no settled route between. Pending
 *  intents aren't evidence — incl. the live one. */
const wallEvidence = (
  rows: JournalRow[],
  stageName: string
): { prev: RoutePayload; died: boolean } | undefined => {
  let prev: RoutePayload | undefined;
  let died = false;
  for (const r of rows) {
    if (r.verdict === undefined) {
      continue;
    }
    if (r.stage === stageName && r.admit !== true) {
      prev = routePayloadOf(r.payload);
      died = false;
      continue;
    }
    if (r.intent === 'spawn' && r.verdict === 'rate_limited') {
      died = true;
    }
  }
  return prev === undefined ? undefined : { prev, died };
};

/** The chain slot the death landed on — the journaled provider/model
 *  pair names it (the pair IS the slot: a model pin applies only to
 *  its own provider); drift out of the table reads as "the head was
 *  tried" so dispatch starts past index 0. */
const chainSlot = (row: RoutingClass, prev: RoutePayload): number => {
  const idx = row.chain.findIndex(e => e.provider === prev.provider && e.model === prev.model);
  return idx === -1 ? 0 : idx;
};

/** Did THIS wake come back through `work.rate_limited`? The journal is
 *  the authority: the last settled record for THIS stage followed by a
 *  settled `rate_limited` on a spawn intent — with no settled route in
 *  between — means the run re-enters routing on a wall. (The intent
 *  keys it, not the stage name: `spawn` is what the runner derives for
 *  a fleet-engine stage whatever the formula calls it, and a `rate_
 *  limited` verdict is the wall signature.) An admission REFUSAL with
 *  a rate_limited verdict counts too — the wall is real even though
 *  the spawn never fired. A queue-parked route that simply woke shows
 *  no death and takes the fresh path, same as a first route — and so
 *  does a journaled class that drifted out of the routing table (the
 *  anchor is gone; resolveStepClass would only throw on it). */
function wallHit(call: StageCall, routing: RoutingTable): WallHit | undefined {
  const ev = wallEvidence(
    journalRecords(
      call.journal.rows().filter(r => r.run_id === call.runId && r.item === call.item)
    ),
    call.stage.name
  );
  if (!ev?.died) {
    return undefined;
  }
  const row = Object.hasOwn(routing, ev.prev.class) ? routing[ev.prev.class] : undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    prev: ev.prev,
    chainIndex: chainSlot(row, ev.prev),
    wall: {
      provider: typeof ev.prev.provider === 'string' ? ev.prev.provider : '',
      cause: 'rate_limited',
    },
  };
}

// --- labels -----------------------------------------------------------------------

const classMark = (l: string): boolean => l.startsWith(CLASS_LABEL_PREFIX);

/** `class:<cls>` — the lane pin `resolveStepClass`/`routeStepClass`
 *  read downstream. Replaced like classify's marks: stale `class:`
 *  labels are removed first so re-routing never double-tags, and the
 *  write is skipped when the pin already stands. */
function tagClass(deps: RouteDeps, itemId: string, cls: string): void {
  if (deps.labels === false) {
    return;
  }
  const tag = `${CLASS_LABEL_PREFIX}${cls}`;
  // re-read through the seam — a label landing mid-run must be seen,
  // not clobbered on a stale snapshot (same guard as classify's)
  const labels = deps.backlog.item(itemId)?.labels ?? [];
  for (const l of labels) {
    if (classMark(l) && l !== tag) {
      deps.backlog.removeLabel(itemId, l);
    }
  }
  if (!labels.includes(tag)) {
    deps.backlog.addLabel(itemId, tag);
  }
}

// --- the verdict ------------------------------------------------------------------

function payloadOf(cx: Cx, resolved: ResolvedClass): RoutePayload {
  const p: RoutePayload = {
    class: resolved.class,
    kind: kindOf(cx),
    orch: orchOf(cx),
    timing: 'now',
  };
  if (cx.res.lowConfidence.length > 0) {
    p.lowConfidence = [...cx.res.lowConfidence];
  }
  return p;
}

/** The fresh path — judge → routing fields, resolve → dispatch.
 *  Precedence is decisive-first: an affirmed operator defer outranks
 *  everything (the lane still resolves so the payload records where
 *  the item WOULD run), then the deterministic parks (walls,
 *  saturation), then the judged timing, then spawn. The dispatch runs
 *  BEFORE the verdicts split precisely so defer/queue payloads carry
 *  the resolved slot — the pin is what a wake re-dispatches. */
function freshVerdict(cx: Cx): EngineResult {
  const resolved = resolveStepClass(cx.deps.routing, cx.deps.providers, {
    class: classOf(cx),
    priority: cx.item.priority,
  });
  const p = payloadOf(cx, resolved);
  const done = (verdict: 'defer' | 'queue' | 'spawn'): EngineResult => {
    tagClass(cx.deps, cx.itemId, resolved.class);
    return { verdict, payload: p };
  };
  const d = dispatch(resolved, 0, cx.walled);
  p.provider = d.provider;
  p.model = d.model;
  if (deferred(cx)) {
    p.timing = 'queue';
    return done('defer');
  }
  if (d.verdict === 'queue') {
    p.timing = 'queue';
    p.reason = d.reason;
    return done('queue');
  }
  if (saturated(cx.load)) {
    p.timing = 'queue';
    p.reason = QUEUE_REASONS.saturated;
    return done('queue');
  }
  if (judgedTiming(cx) === 'queue') {
    p.timing = 'queue';
    p.reason = QUEUE_REASONS.timing;
    return done('queue');
  }
  return done('spawn');
}

/** `park` keeps the died-on provider/model pair — the slot the queue
 *  payload records as where the item WOULD run once the wall lifts. */
const keepDiedOn = (p: RoutePayload, prev: RoutePayload): void => {
  if (typeof prev.provider === 'string') {
    p.provider = prev.provider;
    if (typeof prev.model === 'string') {
      p.model = prev.model;
    }
  }
};

/** The wall path's inputs — one bag keeps the helper under the arg
 *  ceiling (same Checks-pattern as the fresh path's Cx). */
interface WallCx {
  deps: RouteDeps;
  item: TaskRow;
  hit: WallHit;
  load: RouteLoad | undefined;
  walled: Set<string>;
}

/** The wall path — no decide: the journaled routing fields stand and
 *  `onWall` answers the wall. `park` queues on the spot keeping the
 *  died-on provider/model pair — the slot the payload records as
 *  where the item WOULD run once the wall lifts; `fallthrough`
 *  dispatches the next un-walled entry (chain-spent parks). The
 *  `class:` label is re-asserted — the class never changed, but a
 *  stale pin from another writer still gets replaced. */
function wallVerdict(cx: WallCx): EngineResult {
  const { deps, item, hit, load, walled } = cx;
  const resolved = resolveStepClass(deps.routing, deps.providers, {
    class: hit.prev.class,
    priority: item.priority,
  });
  const p: RoutePayload = {
    class: resolved.class,
    kind: typeof hit.prev.kind === 'string' ? hit.prev.kind : DEFAULT_ROUTE_KIND,
    orch: isOrch(hit.prev.orch) ? hit.prev.orch : DEFAULT_ROUTE_ORCH,
    timing: 'queue',
  };
  if (hit.wall.provider !== '') {
    p.wall = hit.wall;
  }
  const done = (verdict: 'queue' | 'spawn'): EngineResult => {
    tagClass(deps, item.id, resolved.class);
    return { verdict, payload: p };
  };
  // onWall answers BEFORE any dispatch — `park` waits the wall out
  // parked, it never walks the chain (spec §work: "park answers
  // queue→park")
  if (resolved.onWall === 'park') {
    p.reason = QUEUE_REASONS.onwall;
    keepDiedOn(p, hit.prev);
    return done('queue');
  }
  const d = dispatch(resolved, hit.chainIndex + 1, walled);
  p.provider = d.provider;
  p.model = d.model;
  if (d.verdict === 'queue') {
    p.reason = d.reason;
    return done('queue');
  }
  if (saturated(load)) {
    p.reason = QUEUE_REASONS.saturated;
    return done('queue');
  }
  p.timing = 'now';
  return done('spawn');
}

/**
 * The route stage as an EngineHandler for the runner's `judge` slot —
 * fresh entries take one decide over item+load, wall re-entries
 * (journaled `rate_limited` on a spawn intent) take the deterministic
 * `onWall` path. Judge unavailability, a missing item, and a broken
 * `fleet.routing` row THROW: the runner's pending intent is the crash
 * marker, and the stage's side effects (remove-then-add `class:`) are
 * idempotent under re-fire.
 */
export function routeStage(deps: RouteDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineResult> {
      const item = deps.backlog.item(call.item);
      if (item === undefined) {
        throw new Error(`route: item "${call.item}" is not in the backlog`);
      }
      if (Object.keys(deps.routing).length === 0) {
        throw new Error('route: deps.routing is empty — declare fleet.routing.<class>.chain');
      }
      const load = loadFor(deps);
      const walls = deps.walls === undefined ? [] : deps.walls();
      const walled = new Set(walls.map(w => w.provider));
      const hit = wallHit(call, deps.routing);
      if (hit !== undefined) {
        return wallVerdict({ deps, item, hit, load, walled });
      }
      const res = await deps.judge.decide(stateFor(item, load, walls), routeQuestions(deps));
      const cx: Cx = {
        deps,
        itemId: call.item,
        item,
        res,
        load,
        walled,
      };
      return freshVerdict(cx);
    },
  };
}
