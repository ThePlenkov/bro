/**
 * The `classify` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-7d5nb.3) — G1 intake intelligence. One item, one decide(): the
 * judge reads the bead + its candidate peers and answers typed
 * questions the core interprets into the stage's verdict enum:
 *
 *   duplicate — the item is a semantic dup of a peer → close
 *   defer     — not ready / wrong time              → park
 *   clump     — shares surface with peers           → route (grouped)
 *   solo      — stands alone                        → route
 *
 * The payload the runner absorbs into the pipeline context:
 * `{group, complexity, rank, clumpId?, dupOf?, reason?}` — `group` IS
 * the verdict; `complexity` is the typed field `review.gate_on`
 * reads; `rank` orders the item (LIFO stays the tie-breaker inside a
 * group, per spec).
 *
 * Two injected seams keep the stage provider- and store-agnostic:
 * `judge` is the existing JudgeFacade call path (the decide contract —
 * never a second judge client); `backlog` fronts the task store so
 * tests drive fakes and prod wires `taskBacklog(taskStore(dir))`.
 * Labels (`dup:<id>`, `clump:<id>`) are the bead-visible side effects
 * the spec assigns to classify — written through the seam, never
 * through bd argv.
 *
 * Judge mechanics: the facade answers choice/score/noul only, so every
 * datum the stage needs is shaped as typed questions — dedup is a
 * `choice` over the peer ids, clump-mates are per-peer `noul`s, defer
 * reason is a `choice` over declared reason codes. A `lowConfidence`
 * answer is NOT honored for the gating questions (dup/defer/clump) —
 * uncertain intake falls back to the safe shape (solo + complex),
 * never to closing or parking someone's work on a dim answer.
 */
import type {
  DecideResult,
  JudgeAnswer,
  JudgeFacade,
  JudgeQuestion,
  TaskRow,
  TaskStore,
} from '@broject/core';
import {
  DEFAULT_ADMIT_INTENTS,
  STAGE_INTENTS,
  type EngineFn,
  type EngineHandler,
  type EngineResult,
  type StageCall,
} from '../runner.ts';

/** Label a duplicate carries — `dup:<id>` names the peer it duplicates. */
export const DUP_LABEL_PREFIX = 'dup:';
/** Label every member of a group carries — `clump:<id>` names the group. */
export const CLUMP_LABEL_PREFIX = 'clump:';
/** Peers shown to the judge in one decide — bounds the criteria the
 *  prompt carries; the seam may return more for its own scoping. */
export const DEFAULT_MAX_PEERS = 8;
/** Store-side peer cap for {@link taskBacklog} — ready ∪ open ∪
 *  in-progress rows deduped down to this many candidates. */
export const DEFAULT_PEER_LIMIT = 16;
/** Defer reason codes the `defer_reason` choice declares — the answer
 *  is an enum, never prose. */
export const DEFER_REASONS = ['blocked', 'not-ready', 'wrong-time', 'needs-info', 'other'] as const;
export type DeferReason = (typeof DEFER_REASONS)[number];

/** noul ≥ this means the judge affirms the yes/no question. */
const AFFIRM = 0.5;
/** rank emitted when the judge gives no confident rank — spec's
 *  neutral position (runs 1+ used low ints for first-in-line). */
const DEFAULT_RANK = 1;
/** rank score scale — criteria low→high; emitted rank inverts it
 *  (highest precedence = rank 1). */
const RANK_LEVELS = [
  'works last — every peer first',
  'late — after most peers',
  'middle of the order',
  'early — before most peers',
  'works first — ahead of every peer',
] as const;

/** `dup_of` criteria key for "not a duplicate of any peer". */
const NO_DUP = 'none';
/** `clump` choice naming a freshly-formed group — the item's own id
 *  becomes the clump id (the founding member names the group). */
const NEW_CLUMP = 'new';
/** `clump` choice for a standalone item. */
const NO_CLUMP = 'solo';
const mateQid = (peerId: string): string => `mate_${peerId}`;

export type ClassifyGroup = 'solo' | 'clump' | 'duplicate' | 'defer';
export type ClassifyComplexity = 'cheap' | 'complex';

/** The stage's typed payload — merged into the pipeline context flat
 *  AND under `classify`, so `complexity` resolves for review's
 *  `gate_on`. */
export interface ClassifyPayload {
  group: ClassifyGroup;
  complexity: ClassifyComplexity;
  rank: number;
  clumpId?: string;
  dupOf?: string;
  reason?: string;
  /** question ids the chain left under-confidence — telemetry, the
   *  dimmed answers were not honored. */
  lowConfidence?: string[];
}

/** The task-store seam — prod binds {@link taskBacklog} over
 *  `TaskStore`, tests fake it. Peers are the candidate set the judge
 *  compares against: ready/open (and claimed) beads minus the item. */
export interface ClassifyBacklog {
  /** the item under classification — undefined when the store misses
   *  it (a miss is invalid input: the engine throws, never classifies
   *  a phantom) */
  item(id: string): TaskRow | undefined;
  /** candidate peers for dedup/grouping — the item itself excluded */
  peers(item: TaskRow): TaskRow[];
  addLabel(id: string, label: string): void;
  removeLabel(id: string, label: string): void;
}

export interface ClassifyDeps {
  judge: JudgeFacade;
  backlog: ClassifyBacklog;
  /** peers offered to one decide — default {@link DEFAULT_MAX_PEERS} */
  maxPeers?: number;
  /** write `dup:`/`clump:` labels — default true; tests and dry
   *  consumers disable with `false` */
  labels?: boolean;
}

/** The verdict arm + the fields its payload carries — interpreted
 *  from the decide's answers, never read off a single "verdict"
 *  question (typed questions are the contract; the group is derived). */
interface Classification {
  group: ClassifyGroup;
  clumpId?: string;
  dupOf?: string;
  reason?: string;
  /** peer ids sharing the item's clump — label targets */
  mates: string[];
}

/** Invocation context — one bag keeps the helpers under the arg
 *  ceiling (same Checks-pattern as formula.ts). */
interface Cx {
  deps: ClassifyDeps;
  itemId: string;
  item: TaskRow;
  peers: TaskRow[];
  res: DecideResult;
}

/** An answer the chain left under-confidence is unread — dim intake
 *  signals never gate. */
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

const scoreOf = (res: DecideResult, qid: string): number | undefined => {
  const a = answer(res, qid);
  return a?.type === 'score' ? a.score : undefined;
};

/** Peer → the criteria row the judge reads — title plus the labels
 *  that already mark its group/class lanes. */
const peerText = (p: TaskRow): string =>
  [p.title ?? '', p.labels?.length ? `labels: ${p.labels.join(', ')}` : '']
    .filter(s => s !== '')
    .join(' — ');

/** `clump:<id>` → the joinable id, or undefined — ids colliding with
 *  the `solo`/`new` sentinels are skipped: a `clump:solo` label is a
 *  name some other scheme wrote, never this stage's sentinel, and
 *  letting it into the criteria would make the sentinel ambiguous. */
const clumpIdOf = (l: string): string | undefined => {
  if (!l.startsWith(CLUMP_LABEL_PREFIX)) {
    return undefined;
  }
  const id = l.slice(CLUMP_LABEL_PREFIX.length);
  return id !== '' && id !== NO_CLUMP && id !== NEW_CLUMP ? id : undefined;
};

/** The clump ids already claimed on peer labels — `clump` choices the
 *  judge can join without minting a new group. */
function existingClumps(peers: TaskRow[]): string[] {
  const ids = new Set<string>();
  for (const p of peers) {
    for (const l of p.labels ?? []) {
      const id = clumpIdOf(l);
      if (id !== undefined) {
        ids.add(id);
      }
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Semantic dedup — a `choice` over the peer ids (+`none`): the judge
 *  names WHICH peer the item duplicates, never a free-form string. */
const dupQuestion = (peers: TaskRow[]): JudgeQuestion => {
  const criteria: Record<string, string> = { [NO_DUP]: 'not a duplicate of any peer' };
  for (const p of peers) {
    criteria[p.id] = `duplicates peer ${p.id} — ${peerText(p)}`;
  }
  return {
    type: 'choice',
    instructions:
      'Is the item a semantic duplicate of one of the peers — the same problem, the same fix, ' +
      'overlapping scope such that only one should be worked? Judge by the work described, ' +
      'not by identical titles.',
    criteria,
  };
};

const deferQuestion = (): JudgeQuestion => ({
  type: 'noul',
  instructions:
    'Probability that this item should be deferred — not ready to work (scope/spec unclear) ' +
    'or the wrong time for it, beyond the blockers its metadata already lists.',
});

const deferReasonQuestion = (): JudgeQuestion => ({
  type: 'choice',
  instructions: 'When the item should be deferred, the closest reason:',
  criteria: {
    blocked: 'waiting on other work or other people',
    'not-ready': 'scope, spec, or detail is not ready to execute',
    'wrong-time': 'ready, but now is the wrong moment (freeze, sequencing)',
    'needs-info': 'missing information only a human can supply',
    other: 'a reason none of the above covers',
  },
});

/** The group choice — `solo`, `new` (the founding member names the
 *  clump), or an existing `clump:<id>` seen on a peer's labels. */
const clumpQuestion = (peers: TaskRow[]): JudgeQuestion => {
  const criteria: Record<string, string> = {
    [NO_CLUMP]: 'stands alone — shares no surface with any peer',
    [NEW_CLUMP]:
      'forms a NEW group with one or more peers — name the shared surface via the mate_* answers',
  };
  for (const id of existingClumps(peers)) {
    criteria[id] = `joins the existing group "${id}"`;
  }
  return {
    type: 'choice',
    instructions:
      'Which group does the item belong to — work sharing its surface (same spec, epic, area, ' +
      'or touched paths) such that the items should be ordered and worked together?',
    criteria,
  };
};

const complexityQuestion = (): JudgeQuestion => ({
  type: 'choice',
  instructions: 'How hard is this item to land correctly?',
  criteria: {
    cheap: 'mechanical or small — a correct diff is near-obvious',
    complex: 'judgment calls, cross-cutting change, or real risk of landing wrong',
  },
});

const rankQuestion = (): JudgeQuestion => ({
  type: 'score',
  instructions:
    'Where does the item belong in the working order — weighing value, dependency order, ' +
    'and grouping? 0 = work it last, 4 = work it first.',
  criteria: [...RANK_LEVELS],
});

const mateQuestion = (p: TaskRow): JudgeQuestion => ({
  type: 'noul',
  instructions:
    `Probability that peer ${p.id} (${peerText(p)}) shares the item's surface — same spec, ` +
    "epic, area, or paths — and belongs in the item's group.",
});

/** One decide's worth of questions — dedup + defer + clump (+ per-peer
 *  mates) + complexity + rank, batched so the backends evaluate them
 *  in parallel. Domain vocabulary only: the judge sees work items and
 *  peers, never pipeline mechanics. */
function classifyQuestions(peers: TaskRow[]): Record<string, JudgeQuestion> {
  const q: Record<string, JudgeQuestion> = {
    dup_of: dupQuestion(peers),
    defer: deferQuestion(),
    defer_reason: deferReasonQuestion(),
    clump: clumpQuestion(peers),
    complexity: complexityQuestion(),
    rank: rankQuestion(),
  };
  for (const p of peers) {
    q[mateQid(p.id)] = mateQuestion(p);
  }
  return q;
}

/** The judge-visible state — bead fields only, trimmed to what
 *  dedup/group/complexity judge on. */
const stateFor = (item: TaskRow, peers: TaskRow[]): Record<string, unknown> => ({
  item: rowView(item),
  peers: peers.map(rowView),
});

const rowView = (r: TaskRow): Record<string, unknown> => ({
  id: r.id,
  title: r.title,
  description: r.description,
  labels: r.labels,
  priority: r.priority,
  parent: r.parent,
  status: r.status,
});

/** The peer a confident `dup_of` names — validated against the peer
 *  set (a fake/drifted answer naming a non-peer is no dup). */
function dupOf(cx: Cx): string | undefined {
  const id = confident(cx.res, 'dup_of') ? choiceOf(cx.res, 'dup_of') : undefined;
  return id !== undefined && id !== NO_DUP && cx.peers.some(p => p.id === id) ? id : undefined;
}

function deferred(cx: Cx): boolean {
  return confident(cx.res, 'defer') && (noulOf(cx.res, 'defer') ?? 0) >= AFFIRM;
}

function deferReason(cx: Cx): string {
  const r = confident(cx.res, 'defer_reason') ? choiceOf(cx.res, 'defer_reason') : undefined;
  return r !== undefined && (DEFER_REASONS as readonly string[]).includes(r) ? r : 'unspecified';
}

/** Peers the judge affirmed as clump-mates — confident `mate_*` nouls
 *  at/above the affirm line. */
function mateIds(cx: Cx): string[] {
  return cx.peers
    .filter(p => {
      const qid = mateQid(p.id);
      return confident(cx.res, qid) && (noulOf(cx.res, qid) ?? 0) >= AFFIRM;
    })
    .map(p => p.id);
}

/** The clump arm — 'solo' or an unconfident answer folds into the
 *  default (the caller's solo), 'new' mints a clump id from the
 *  founding member, an existing id joins that group. */
function clumpOf(cx: Cx): Pick<Classification, 'group' | 'clumpId' | 'mates'> {
  const pick = confident(cx.res, 'clump') ? choiceOf(cx.res, 'clump') : undefined;
  if (pick === undefined || pick === NO_CLUMP) {
    return { group: 'solo', mates: [] };
  }
  const mates = mateIds(cx);
  if (pick === NEW_CLUMP && mates.length === 0) {
    // A 'new' clump needs at least one affirmed mate — otherwise the
    // item stands alone and minting a self-named clump label lies.
    return { group: 'solo', mates: [] };
  }
  return {
    group: 'clump',
    clumpId: pick === NEW_CLUMP ? cx.itemId : pick,
    mates,
  };
}

/** Answers → verdict. Precedence is decisive-first: duplicate (a
 *  terminal close) outranks defer (a park) outranks grouping. */
function verdictOf(cx: Cx): Classification {
  const dup = dupOf(cx);
  if (dup !== undefined) {
    return { group: 'duplicate', dupOf: dup, mates: [] };
  }
  if (deferred(cx)) {
    return { group: 'defer', reason: deferReason(cx), mates: [] };
  }
  return clumpOf(cx);
}

/** `complexity` — cheap only on a confident cheap; anything else
 *  stays complex so a dimmed judge never sneaks work past review. */
function complexityOf(cx: Cx): ClassifyComplexity {
  return confident(cx.res, 'complexity') && choiceOf(cx.res, 'complexity') === 'cheap'
    ? 'cheap'
    : 'complex';
}

/** `rank` — the score's level inverted into an int position: level 4
 *  (works first) → rank 1, level 0 → rank 5. */
function rankOf(cx: Cx): number {
  const score = confident(cx.res, 'rank') ? scoreOf(cx.res, 'rank') : undefined;
  if (score === undefined) {
    return DEFAULT_RANK;
  }
  return Math.min(RANK_LEVELS.length, Math.max(1, RANK_LEVELS.length - Math.round(score)));
}

function payloadOf(cx: Cx, v: Classification): ClassifyPayload {
  const p: ClassifyPayload = {
    group: v.group,
    complexity: complexityOf(cx),
    rank: rankOf(cx),
  };
  if (v.clumpId !== undefined) p.clumpId = v.clumpId;
  if (v.dupOf !== undefined) p.dupOf = v.dupOf;
  if (v.reason !== undefined) p.reason = v.reason;
  if (cx.res.lowConfidence.length > 0) p.lowConfidence = [...cx.res.lowConfidence];
  return p;
}

/** The one label this verdict writes on the item — undefined for
 *  solo/defer (they mark the bead nowhere). */
function itemLabel(v: Classification): string | undefined {
  if (v.group === 'duplicate') {
    return `${DUP_LABEL_PREFIX}${v.dupOf}`;
  }
  return v.group === 'clump' ? `${CLUMP_LABEL_PREFIX}${v.clumpId}` : undefined;
}

const classifyMark = (l: string): boolean =>
  l.startsWith(DUP_LABEL_PREFIX) || l.startsWith(CLUMP_LABEL_PREFIX);

/** The item is RELABELED — stale `dup:`/`clump:` marks are removed
 *  first so re-classification never double-tags, then the verdict's
 *  own label lands (skipped when already present). */
function retagItem(cx: Cx, tag: string | undefined): void {
  const b = cx.deps.backlog;
  const labels = cx.item.labels ?? [];
  for (const l of labels) {
    if (classifyMark(l) && l !== tag) {
      b.removeLabel(cx.itemId, l);
    }
  }
  if (tag !== undefined && !labels.includes(tag)) {
    b.addLabel(cx.itemId, tag);
  }
}

/** Clump-mates get the group label only when they carry none — an
 *  existing membership wins over a second tag (first-writer keeps
 *  each bead single-clumped). */
function tagMates(cx: Cx, tag: string, mates: string[]): void {
  for (const id of mates) {
    // Re-read through the seam — cx.peers is a snapshot from invoke's
    // start and a concurrent run's write must not be clobbered on a
    // stale label check.
    const mate = cx.deps.backlog.item(id);
    const clumped = mate?.labels?.some(l => l.startsWith(CLUMP_LABEL_PREFIX)) ?? false;
    if (mate !== undefined && !clumped) {
      cx.deps.backlog.addLabel(id, tag);
    }
  }
}

/** Bead-visible output (spec §classify: "output lands as bead
 *  labels") — the item is relabeled to the verdict's mark, then
 *  clump-mates join the group label. */
function relabel(cx: Cx, v: Classification): void {
  if (cx.deps.labels === false) {
    return;
  }
  const tag = itemLabel(v);
  retagItem(cx, tag);
  if (v.group === 'clump' && tag !== undefined) {
    tagMates(cx, tag, v.mates);
  }
}

/**
 * The classify stage as an EngineHandler for the runner's `judge`
 * slot — one decide over item+peers, typed answers interpreted into
 * the verdict, labels written through the backlog seam. Judge
 * unavailability and a missing item THROW: the runner's pending
 * intent is the crash marker, and a judge-side intent is safe to
 * re-fire (labels remove-then-add idempotently).
 */
export function classifyStage(deps: ClassifyDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineResult> {
      const item = deps.backlog.item(call.item);
      if (item === undefined) {
        throw new Error(`classify: item "${call.item}" is not in the backlog`);
      }
      const maxPeers = deps.maxPeers ?? DEFAULT_MAX_PEERS;
      if (!Number.isInteger(maxPeers) || maxPeers < 0) {
        throw new Error(`classify: maxPeers must be a non-negative integer, got ${maxPeers}`);
      }
      const peers = deps.backlog
        .peers(item)
        .filter(p => p.id !== item.id)
        .slice(0, maxPeers);
      const res = await deps.judge.decide(stateFor(item, peers), classifyQuestions(peers));
      const cx: Cx = { deps, itemId: call.item, item, peers, res };
      const v = verdictOf(cx);
      relabel(cx, v);
      return { verdict: v.group, payload: payloadOf(cx, v) };
    },
  };
}

/**
 * One engine slot, several stages — the formula binds classify,
 * route, and review all to `judge`; the runner resolves handlers by
 * ENGINE name, so this handler multiplexes on `call.stage.name`.
 * Bind what the formula uses:
 *
 *   engines: { judge: stageDispatch({ classify: classifyStage(deps),
 *                                    route: routeStage(deps) }) }
 *
 * An unbound stage throws loudly — a misbound engine map is a wiring
 * bug, never a silent wrong-stage verdict. `recheck` forwards to the
 * stage's own hook; when the bound stage has none, the wrapper cannot
 * just return undefined — that attests "didn't land", which re-fires
 * ANY pending intent including spawn-like ones (the runner's
 * fail-closed no-hook park only sees `recheck === undefined`, and this
 * wrapper always binds one). Spawn-like intents get 'pending' — park,
 * never a blind respawn; read intents keep undefined, the bounded
 * re-fire judge stages want. (Custom `admitIntents` beyond
 * DEFAULT_ADMIT_INTENTS aren't visible here — bind a recheck hook for
 * non-standard spawn-like stages.)
 */
export function stageDispatch(bindings: Record<string, EngineFn | EngineHandler>): EngineHandler {
  const map = new Map<string, EngineHandler>();
  for (const [stage, h] of Object.entries(bindings)) {
    map.set(stage, typeof h === 'function' ? { invoke: h } : h);
  }
  const bound = (call: StageCall): EngineHandler => {
    const h = map.get(call.stage.name);
    if (h === undefined) {
      throw new Error(`stageDispatch: no engine bound for stage "${call.stage.name}"`);
    }
    return h;
  };
  return {
    invoke: call => bound(call).invoke(call),
    recheck: call => {
      const h = bound(call);
      if (h.recheck !== undefined) {
        return h.recheck(call);
      }
      const intent = STAGE_INTENTS[call.stage.engine] ?? call.stage.engine;
      return DEFAULT_ADMIT_INTENTS.includes(intent) ? 'pending' : undefined;
    },
  };
}

/** Significant title tokens — ≥4 chars, the overlap signal affinity
 *  scores on (short tokens are noise: "the", "a", "fix"). */
const titleTokens = (s: string | undefined): Set<string> =>
  new Set(
    (s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4)
  );

/** |A ∩ B| over a set — shared labels/tokens counted without
 *  embedding a loop in the scorer. */
const countShared = (xs: readonly string[], set: Set<string>): number =>
  xs.reduce((n, x) => (set.has(x) ? n + 1 : n), 0);

/** How relevant a peer is to THIS item's classification — the signal
 *  the candidate cap should keep. Shared parent (one epic's siblings
 *  clump) outranks shared labels (same surface) outranks title-token
 *  overlap (likely duplicates read alike). */
function affinity(item: TaskRow, p: TaskRow): number {
  const parent = item.parent !== undefined && item.parent === p.parent ? 4 : 0;
  const labels = countShared(p.labels ?? [], new Set(item.labels ?? []));
  const tokens = countShared([...titleTokens(p.title)], titleTokens(item.title));
  return parent + 2 * labels + tokens;
}

/**
 * The prod backlog — the TaskStore-facing ClassifyBacklog. Peers are
 * the intake candidate set: the ready queue, then open and
 * in-progress rows to the cap — dedup must see claimed work (a
 * duplicate of an in-flight item is still a duplicate). The cap is
 * taken by AFFINITY, not position: an unrelated ready queue must not
 * crowd a likely duplicate out of the judge's criteria — the sort is
 * stable, so equal-affinity peers keep their tier order (ready →
 * open → in_progress). Label writes ride `bd update
 * --add-label/--remove-label` through the store's patch map.
 */
export function taskBacklog(store: TaskStore, opts: { limit?: number } = {}): ClassifyBacklog {
  const limit = opts.limit ?? DEFAULT_PEER_LIMIT;
  const peers = (item: TaskRow): TaskRow[] => {
    const seen = new Set<string>([item.id]);
    const out: TaskRow[] = [];
    const push = (rows: TaskRow[]): void => {
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out.push(r);
        }
      }
    };
    push(store.ready());
    push(store.list({ status: 'open', limit }));
    push(store.list({ status: 'in_progress', limit }));
    return out
      .map((r, i) => ({ r, i, s: affinity(item, r) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, limit)
      .map(e => e.r);
  };
  return {
    item: id => store.get(id),
    peers,
    addLabel: (id, label) => store.update(id, { 'add-label': label }),
    removeLabel: (id, label) => store.update(id, { 'remove-label': label }),
  };
}
