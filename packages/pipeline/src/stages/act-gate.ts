/**
 * The `act-gate` stage engine (specs/bro-7d5nb.md §merge, epic child
 * bro-v0pvd.2) — the PR settle probe. The formula's `merge` stage
 * declares `engine = "act-gate"` with verdicts `landed|blocked|
 * dropped`; this factory is the EngineHandler that binds it:
 *
 *   invoke  — resolve the run's PR identity from the pipeline ctx,
 *             probe the act state through the injected seam, map the
 *             lifecycle + gate read onto the verdict enum. Still
 *             settling → 'pending' (the runner parks WITHOUT a
 *             verdict row — the gate intent stays the resume
 *             anchor); settled → the verdict lands in the same wake.
 *   recheck — the SAME probe on wake: read-only and idempotent, so
 *             invoke and recheck share one settle path — no dedup
 *             channel is needed (unlike accept's emit, nothing was
 *             fired that could double). 'pending' re-parks; a
 *             settled observation completes the pending record.
 *             recheck never returns undefined — there is no "did the
 *             side effect land" question: the intent IS the read,
 *             and the probe always answers the CURRENT state.
 *
 * Lifecycle → verdict (the act gate's settle state, mapped once):
 *
 *   MERGED                    → landed   (it landed — gate moot)
 *   CLOSED                    → dropped  (closed unmerged → close)
 *   OPEN + gate.settling      → pending  (still in flight — wait)
 *   OPEN + settled + gate.ok  → landed   (the gate settled green)
 *   OPEN + settled + !gate.ok → blocked  (settled with blockers →
 *                                        retry, bounded by
 *                                        pipeline.maxAttempts)
 *
 * `settling` is checked FIRST: a PR carrying a settled blocker AND a
 * pending check is still settling — 'pending' waits for free on the
 * next wake instead of burning the retry budget on a gate that has
 * not finished computing (the @broject/act `gatePending` semantics,
 * which the probe dep owns).
 *
 * PR identity comes from the pipeline ctx — the work stage's
 * payload carries `pr`/`worktree` (bro-qjji2.12), `draft_pr` is the
 * accept bundle's established alias. Payloads merge flat AND under
 * their stage name, so the candidates read flat-first (the merged
 * view `gate_on` also reads — freshest wins) with `work.*` as the
 * defensive fallback. Absent or malformed identity parks fail-closed
 * (`pr-identity-missing`) — the same contract as accept's missing
 * run.customer: the gate cannot probe what it cannot name, and a
 * corrected context on a later wake can still settle. A probe
 * answering `undefined` — definitive "no PR at this ref" — parks
 * `pr-unreadable`; transient/read failures THROW through the seam
 * (the pending intent is the crash marker, the bounded re-fire is
 * the retry).
 *
 * The payload keeps probe provenance NESTED under `gate` — flat
 * `provider`/`model` keys belong to route's payload and would flip
 * their meaning mid-pipeline (review's `reviewer` slot set the
 * precedent). `pr` echoes the resolved ref verbatim — capture's land
 * scan reads the `landed` record's payload as lesson evidence.
 *
 * Injected seams keep the stage provider- and store-agnostic: `probe`
 * IS the whole host surface — prod binds `fetchPrActState` +
 * `evaluateExitGate` + `gatePending` behind it (the act package owns
 * the settle semantics; this file maps the normalized observation
 * onto the formula enum and never sees a vendor type).
 */
import type { MaybePromise } from '@broject/core';
import {
  type EngineAlert,
  type EngineHandler,
  type EngineOutcome,
  PARK_ALERTS,
  type StageCall,
} from '../runner.ts';

/** The stage's declared verdicts — the formula's enum. */
export const ACT_GATE_VERDICTS = ['landed', 'blocked', 'dropped'] as const;
export type ActGateVerdict = (typeof ACT_GATE_VERDICTS)[number];

/** The PR ref the stage resolved from ctx and hands the probe —
 *  number (`42`), string (`'pr://77'`, a URL, `'#42'`), or record
 *  (`{repo, number}`, …). The stage validates presence + shape only;
 *  host-vocabulary interpretation is the seam's job. */
export type ActGatePrRef = number | string | Record<string, unknown>;

/** The gate's settle read for an OPEN PR — the dep's normalized
 *  answer (prod: `evaluateExitGate.ok` + `gatePending` + the named
 *  blockers). `settling` is the still-in-flight signal — pending CI,
 *  pending AI reviewers, mergeability still computing; while it
 *  holds the stage answers 'pending', never 'blocked'. */
export interface ActGateRead {
  /** the evaluated gate verdict — every blocker cleared */
  ok: boolean;
  /** still settling — the gate has not finished computing */
  settling: boolean;
  /** the named settled blockers — payload detail on `blocked` */
  blockers?: string[];
  /** settle counts for payload detail — optional telemetry */
  ciPending?: number;
  reviewersPending?: number;
  ciFailing?: number;
  openThreads?: number;
}

/** What the probe reports — the PR's lifecycle plus, for an OPEN
 *  PR, the gate's settle read. `state` uses the host-normalized
 *  PrMeta vocabulary ('OPEN' | 'MERGED' | 'CLOSED'); anything else is
 *  a malformed seam answer and throws. */
export interface ActGateObservation {
  /** PR lifecycle — 'OPEN' | 'MERGED' | 'CLOSED' */
  state: string;
  /** head sha the probe read — landed/blocked provenance */
  headSha?: string;
  /** PR url — display provenance */
  url?: string;
  /** who landed it — `landed` provenance when the host reports it */
  mergedBy?: string;
  /** the gate's settle read — REQUIRED when state is 'OPEN' */
  gate?: ActGateRead;
  /** probe provenance — which backend/connector answered; journaled
   *  nested inside the payload's `gate` slot, never flat */
  provider?: string;
  model?: string;
}

export interface ActGateDeps {
  /** the act-state read — see the module doc for the contract:
   *  read-only, idempotent, `undefined` only for a definitive "no PR
   *  at this ref", throws on read failure. */
  probe: (call: StageCall, pr: ActGatePrRef) => MaybePromise<ActGateObservation | undefined>;
}

/** The stage's typed payload — merged into the pipeline context flat
 *  AND under the stage name (spec §typed stage outputs: the merge
 *  stage emits the act gate's settle state). `gate` nests the whole
 *  settle read + probe provenance — flat `provider`/`model` would
 *  overwrite route's in the merged context. */
export interface ActGatePayload {
  /** the emitted verdict, restated in the payload per the spec's
   *  `{verdict, …}` shape */
  verdict: ActGateVerdict;
  /** the resolved PR ref, echoed verbatim — capture's land scan
   *  reads it as lesson evidence */
  pr: ActGatePrRef;
  /** the probed head sha */
  headSha?: string;
  /** the PR url */
  url?: string;
  /** who merged — `landed` provenance when the host reports it */
  mergedBy?: string;
  /** the gate's settle read + probe provenance — nested, never flat */
  gate?: {
    ok?: boolean;
    settling?: boolean;
    blockers?: string[];
    ciPending?: number;
    reviewersPending?: number;
    ciFailing?: number;
    openThreads?: number;
    provider?: string;
    model?: string;
  };
  /** the derived headline — a deterministic line off the observation */
  summary?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --- PR identity -------------------------------------------------------------

/** ctx keys carrying the run's PR, contract order — flat merged keys
 *  first (the view `gate_on` reads; the freshest `pr`/`draft_pr`
 *  across every settled payload wins), then the `work` stage's own
 *  scoped record as the defensive fallback (its payload may nest the
 *  ref where a later stage's flat key would mask it). `draft_pr` is
 *  the accept bundle's alias for the same ref. */
const PR_CTX_KEYS = ['pr', 'draft_pr'] as const;

/** A usable PR ref — positive integer, non-empty string, or non-empty
 *  record. The stage validates presence + shape only; what the ref
 *  MEANS (number vs url vs {repo, pr}) is the probe's vocabulary. */
function isPrRef(v: unknown): v is ActGatePrRef {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v > 0;
  }
  if (typeof v === 'string') {
    return v !== '';
  }
  return isRecord(v) && Object.keys(v).length > 0;
}

/** The resolved PR ref, or the fail-closed alert — first DEFINED
 *  candidate wins (a malformed `pr` does not fall through to a valid
 *  `draft_pr`: garbage identity is a broken context, parked for a
 *  human, never silently re-pointed). */
function resolvePr(call: StageCall): { ref: ActGatePrRef } | { alert: EngineAlert } {
  const ctx = call.ctx;
  const work = isRecord(ctx.work) ? ctx.work : undefined;
  const candidates: unknown[] = [
    ...PR_CTX_KEYS.map(k => ctx[k]),
    ...(work === undefined ? [] : PR_CTX_KEYS.map(k => work[k])),
  ];
  const raw = candidates.find(v => v !== undefined);
  if (raw === undefined) {
    return {
      alert: {
        alert: PARK_ALERTS.prIdentityMissing,
        detail:
          'pipeline ctx carries no pr/draft_pr (flat or under work) — ' +
          'the merge gate cannot probe a PR it cannot name',
      },
    };
  }
  if (!isPrRef(raw)) {
    return {
      alert: {
        alert: PARK_ALERTS.prIdentityMissing,
        detail:
          `malformed pr identity in pipeline ctx — expected a positive integer, ` +
          `non-empty string, or non-empty record, got ${JSON.stringify(raw)}`,
      },
    };
  }
  return { ref: raw };
}

// --- observation validation ----------------------------------------------------

const LIFECYCLE = ['OPEN', 'MERGED', 'CLOSED'] as const;

const isLifecycle = (v: unknown): v is (typeof LIFECYCLE)[number] =>
  typeof v === 'string' && (LIFECYCLE as readonly string[]).includes(v);

const isOptString = (v: unknown): boolean => v === undefined || typeof v === 'string';
const isOptCount = (v: unknown): boolean => v === undefined || typeof v === 'number';

/** One optional string field on the observation — present must be a
 *  string (a number headSha is malformed data laundered toward the
 *  payload, same rule as verify's evidence rows). */
function checkStrings(obs: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of keys) {
    if (!isOptString(obs[k])) {
      throw new Error(`act-gate: probe returned a malformed observation — ${k} must be a string`);
    }
  }
}

/** The gate read's contract — `ok`/`settling` required booleans,
 *  `blockers` a string list when present, the counts numbers when
 *  present. Anything less is a seam answer the stage cannot map. */
function checkGate(gate: unknown): asserts gate is ActGateRead {
  if (!isRecord(gate)) {
    throw new Error('act-gate: probe returned a malformed observation — gate must be a record');
  }
  if (typeof gate.ok !== 'boolean' || typeof gate.settling !== 'boolean') {
    throw new Error(
      'act-gate: probe returned a malformed gate read — ok and settling must be booleans'
    );
  }
  if (
    gate.blockers !== undefined &&
    !(Array.isArray(gate.blockers) && gate.blockers.every(b => typeof b === 'string'))
  ) {
    throw new Error('act-gate: probe returned a malformed gate read — blockers must be strings');
  }
  for (const k of ['ciPending', 'reviewersPending', 'ciFailing', 'openThreads'] as const) {
    if (!isOptCount(gate[k])) {
      throw new Error(`act-gate: probe returned a malformed gate read — ${k} must be a number`);
    }
  }
}

/** The whole observation, validated before it becomes a verdict —
 *  the seam's contract, enforced like every other stage's. A `gate`
 *  read is shape-checked whenever present (it echoes into the
 *  payload on any lifecycle) and REQUIRED on OPEN — the only state
 *  whose verdict consults it. */
function checkObservation(raw: unknown): asserts raw is ActGateObservation {
  if (!isRecord(raw)) {
    throw new Error(
      'act-gate: the probe seam returned a malformed observation — expected a record'
    );
  }
  if (!isLifecycle(raw.state)) {
    throw new Error(
      `act-gate: the probe seam returned an unknown PR state ${JSON.stringify(raw.state)} — ` +
        `expected ${LIFECYCLE.join('|')}`
    );
  }
  checkStrings(raw, ['headSha', 'url', 'mergedBy', 'provider', 'model']);
  if (raw.gate !== undefined) {
    checkGate(raw.gate);
  }
  if (raw.state === 'OPEN' && raw.gate === undefined) {
    throw new Error(
      'act-gate: probe returned an OPEN PR with no gate read — the settle state is required'
    );
  }
}

// --- the verdict -----------------------------------------------------------------

/** The payload's gate slot — the settle read plus probe provenance,
 *  nested so flat provider/model keep route's meaning. Absent fields
 *  stay absent (a sparse read journals sparse, never fabricated). */
function gateSlot(obs: ActGateObservation): ActGatePayload['gate'] {
  const g = obs.gate;
  if (g === undefined) {
    return undefined;
  }
  const slot: NonNullable<ActGatePayload['gate']> = { ok: g.ok, settling: g.settling };
  if (g.blockers !== undefined && g.blockers.length > 0) {
    slot.blockers = [...g.blockers];
  }
  for (const k of ['ciPending', 'reviewersPending', 'ciFailing', 'openThreads'] as const) {
    const v = g[k];
    if (v !== undefined) {
      slot[k] = v;
    }
  }
  if (obs.provider !== undefined) {
    slot.provider = obs.provider;
  }
  if (obs.model !== undefined) {
    slot.model = obs.model;
  }
  return slot;
}

/** The deterministic headline — off the observation, never the seam. */
function summaryFor(verdict: ActGateVerdict, obs: ActGateObservation): string {
  switch (verdict) {
    case 'landed':
      return obs.state === 'MERGED'
        ? `pr merged${obs.mergedBy !== undefined ? ` by ${obs.mergedBy}` : ''}`
        : 'act gate settled green — merge-ready';
    case 'blocked': {
      const b = obs.gate?.blockers ?? [];
      return b.length > 0 ? `act gate blocked — ${b.join('; ')}` : 'act gate blocked';
    }
    case 'dropped':
      return 'pr closed unmerged — dropped';
  }
}

/** The typed payload — verdict restated, the resolved ref echoed,
 *  head/url/mergedBy provenance, the nested gate read, the headline. */
function payloadFor(
  verdict: ActGateVerdict,
  obs: ActGateObservation,
  ref: ActGatePrRef
): ActGatePayload {
  const p: ActGatePayload = { verdict, pr: ref };
  if (obs.headSha !== undefined) {
    p.headSha = obs.headSha;
  }
  if (obs.url !== undefined) {
    p.url = obs.url;
  }
  if (obs.mergedBy !== undefined) {
    p.mergedBy = obs.mergedBy;
  }
  const gate = gateSlot(obs);
  if (gate !== undefined) {
    p.gate = gate;
  }
  p.summary = summaryFor(verdict, obs);
  return p;
}

/** One validated observation → the stage's answer. Lifecycle decides
 *  first (MERGED/CLOSED never consult the gate read); OPEN maps
 *  settling → pending, then ok → landed, else blocked. */
function outcomeFor(obs: ActGateObservation, ref: ActGatePrRef): EngineOutcome {
  if (obs.state === 'MERGED') {
    return { verdict: 'landed', payload: payloadFor('landed', obs, ref) };
  }
  if (obs.state === 'CLOSED') {
    return { verdict: 'dropped', payload: payloadFor('dropped', obs, ref) };
  }
  // OPEN — the gate read is required (checkObservation proved it)
  const gate = obs.gate as ActGateRead;
  if (gate.settling) {
    return 'pending';
  }
  const verdict: ActGateVerdict = gate.ok ? 'landed' : 'blocked';
  return { verdict, payload: payloadFor(verdict, obs, ref) };
}

/** ctx identity → probe → outcome — the one path invoke and recheck
 *  share. Identity failures and probe-undefined are fail-closed
 *  EngineAlerts; malformed seam answers throw (crash marker). */
async function settle(call: StageCall, deps: ActGateDeps): Promise<EngineOutcome> {
  const pr = resolvePr(call);
  if ('alert' in pr) {
    return pr.alert;
  }
  const obs = await deps.probe(call, pr.ref);
  if (obs === undefined) {
    return {
      alert: PARK_ALERTS.prUnreadable,
      detail: `the act-state probe found no PR at the journaled ref ${JSON.stringify(pr.ref)}`,
    };
  }
  checkObservation(obs);
  return outcomeFor(obs, pr.ref);
}

/**
 * The act-gate stage as an EngineHandler for the runner's `act-gate`
 * slot — probe the run's PR settle state, map it onto
 * landed|blocked|dropped, suspend on 'pending' with the intent as
 * the resume anchor. `invoke` and `recheck` are the same read-only
 * probe: the gate intent carries no side effect to attest, so a
 * wake re-asks the world and the answer settles or re-parks
 * idempotently.
 */
export function actGateStage(deps: ActGateDeps): EngineHandler {
  return {
    invoke: (call: StageCall): Promise<EngineOutcome> => settle(call, deps),
    recheck: (call: StageCall): Promise<EngineOutcome> => settle(call, deps),
  };
}
