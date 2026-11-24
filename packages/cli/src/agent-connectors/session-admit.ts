/**
 * Spawned-command session admission — the cross-kind claim pass a
 * spawn's session starts run under (spec bro-x601l). A compound
 * command can start sessions on several session kinds AND under
 * several provider cap lanes; each kind's pending starts claim
 * serialized slots through `admitSessionSlot` — inside the SAME
 * admission mutex the quota lane's own admit holds — so a
 * check-then-reserve here cannot race a parallel start into
 * overshooting a cap.
 *
 * Leaf module — imports externals only; core re-exports the public
 * pieces (`ProviderGate`, `providerGateForKind`, `providerGatePayload`,
 * `EMPTY_KEYS`, `admitSpawnedCommandStarts`) so existing import sites
 * keep resolving.
 */
import {
  admitSessionSlot,
  type ProviderCapLane,
  type SessionPlane,
  SpawnError,
  sessionCapRefusal,
  sessionCapViews,
  sessionPlane,
} from '@broject/core';

/** The `liveKeys` a kind carries when the caller holds no snapshot —
 *  shared so every admit reads the same empty set. */
export const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** The provider lane a spawn must fit under — `fleet.providerCaps`
 *  resolved to its planes, aggregate census and pre-flight verdict
 *  (spec bro-x601l). ONE shape for every spawn path — the registry's
 *  prepareSpawn and the loop's raw-template lane derive it through
 *  providerGateOf so the wiring cannot drift per call site
 *  (bro-9f78j). */
export interface ProviderGate {
  /** The armed lane — `provider` is the providers.<name> entry key. */
  providerCap: ProviderCapLane;
  /** The command the provider entry spawns sessions through — '' for
   *  an api entry (no plane can claim its lane). */
  providerCommand: string;
  /** Every plane the provider command starts sessions on — a
   *  multi-plane command draws one session per plane on the same
   *  account lane. */
  providerPlanes: readonly SessionPlane[];
  /** The lane's AGGREGATE census — the combined count over every
   *  plane the provider's command claims. Runs INSIDE each plane's
   *  locked section, after its claim landed, so earlier claims sit
   *  inside the count. undefined when the lane is plane-less (its
   *  census is the registry's occupants plus the provider-namespaced
   *  claim ledger). */
  providerCensus: (() => number) | undefined;
  /** The kinds whose census dirs the provider cap counts — a
   *  cross-kind claim on one still owes the aggregate verdict. */
  providerPlaneKinds: ReadonlySet<string>;
  /** The spawn's quota lane kind — the provider pass skips it (the
   *  quota admit carries the verdict instead of claiming twice). */
  quotaPlaneKind: string | undefined;
  /** True when the provider's own session plane IS the quota lane's —
   *  the verdict then rides the quota admit instead of claiming the
   *  lane twice. */
  quotaCoversProvider: boolean;
}

/** The provider gate a session kind claims under — the first gate
 *  whose provider planes cover the kind (config order: the lane the
 *  kind's starts were attributed to). */
export function providerGateForKind(
  gates: readonly ProviderGate[],
  kind: string
): ProviderGate | undefined {
  return gates.find(gate => gate.providerPlaneKinds.has(kind));
}

/** The provider verdict a cross-kind claim carries — the FIRST
 *  covering gate's lane and aggregate census (config order: the lane
 *  the kind's starts were attributed to — it also drives the claim's
 *  census dir), plus every OTHER gate covering the same kind. A kind
 *  two lanes share claims once but each account lane still owes ITS
 *  cap a verdict on the post-claim count — forwarding only the first
 *  gate would let a second lane's cap sit unjudged while the start
 *  lands (spec bro-x601l). Nothing when no gate claims the kind. */
export function providerGatePayload(
  gates: readonly ProviderGate[],
  kind: string
):
  | {
      providerCap: ProviderCapLane;
      providerCensus: (() => number) | undefined;
      /** every OTHER covering gate's verdict — judged inside the same
       *  locked section, after the claim landed */
      extraProviderVerdicts: {
        providerCap: ProviderCapLane;
        providerCensus: (() => number) | undefined;
      }[];
    }
  | Record<string, never> {
  const covering = gates.filter(gate => gate.providerPlaneKinds.has(kind));
  const gate = covering.at(0);
  return gate === undefined
    ? {}
    : {
        providerCap: gate.providerCap,
        providerCensus: gate.providerCensus,
        extraProviderVerdicts: covering.slice(1).map(g => ({
          providerCap: g.providerCap,
          providerCensus: g.providerCensus,
        })),
      };
}

/** The claim context the cross-kind passes share — one spawned
 *  command's identity, live-slot snapshots, provider-gate verdicts,
 *  and the custody list its claims land on. */
interface CrossKindAdmit {
  spawnedCommand: string;
  agents: Record<string, Record<string, unknown>> | undefined;
  workerEnv: Record<string, string> | undefined;
  molStep: string | undefined;
  agentId: string;
  scope: string;
  liveByKind: Map<string, Set<string>>;
  /** the starts the provider pass already claimed, per kind — the
   *  union over every provider gate (one start claims once, so the
   *  gates' counts never overlap) */
  providerClaimedStarts: ReadonlyMap<string, number>;
  /** the provider gates this spawn resolved — a cross-kind start on a
   *  kind one covers still owes that lane's aggregate verdict */
  providerGates: readonly ProviderGate[];
  /** the spawn's own quota lane — its admit covers the kind's full
   *  lane; the cross-kind loops must not double-claim it */
  quotaPlaneKind: string | undefined;
  /** reports a work-budget segment an admit just opened — the caller
   *  refunds them all when a later refusal unwinds the spawn */
  budgetCharged?: (kind: string) => void;
  out: string[];
}

/** One pending start's serialized slot claim — the provider verdict a
 *  cross-kind claim carries rides `providerGatePayload`; starts the
 *  provider pass already admitted are skipped by the caller so their
 *  claims never read as two. */
function claimStart(ctx: CrossKindAdmit, plane: SessionPlane, kind: string, pending: number): void {
  for (let i = 0; i < pending; i++) {
    const claimed = admitSessionSlot(plane, ctx.agents, {
      key: ctx.agentId,
      molStep: ctx.molStep,
      workerEnv: ctx.workerEnv,
      scope: ctx.scope,
      liveKeys: ctx.liveByKind.get(kind) ?? EMPTY_KEYS,
      // a kind a provider gate counts still owes the aggregate
      // verdict — the spawned command can start more of the kind
      // than the provider's own entry did, and the excess claims
      // land on the SAME provider-counted ledger
      ...providerGatePayload(ctx.providerGates, kind),
      ...(ctx.budgetCharged === undefined ? {} : { budgetCharged: ctx.budgetCharged }),
    });
    if (claimed !== undefined) {
      ctx.out.push(claimed);
    }
  }
}

/** The pre-flight refusal ahead of any claim — the authoritative
 *  count re-runs inside each kind's admission mutex during the claim
 *  pass. Starts the provider pass already claimed sit INSIDE the
 *  view's live count — the pending starts are what is left, or one
 *  session's claims read as two and a rightful first spawn refuses. */
function refuseOnCapPreflight(ctx: CrossKindAdmit): void {
  for (const view of sessionCapViews(ctx.spawnedCommand, ctx.agents, ctx.workerEnv)) {
    const pending = Math.max(0, view.starts - (ctx.providerClaimedStarts.get(view.kind) ?? 0));
    const crossRefusal = sessionCapRefusal({ ...view, starts: pending });
    if (crossRefusal !== undefined) {
      throw new SpawnError(crossRefusal, 'cap');
    }
  }
}

/** Every session-kind view's pending starts — claimed through the
 *  kind's OWN admission mutex so a multi-start view takes one
 *  serialized slot per start; a refusal mid-way is rolled back by the
 *  caller's catch. Returns the kinds this pass covered — the
 *  uncovered-provider pass must not double-claim them. */
function claimViewKindStarts(ctx: CrossKindAdmit): Set<string> {
  const coveredKinds = new Set<string>();
  for (const view of sessionCapViews(ctx.spawnedCommand, ctx.agents, ctx.workerEnv)) {
    if (view.kind === ctx.quotaPlaneKind) {
      continue; // admitSessionSlot below covers this kind's full lane
    }
    coveredKinds.add(view.kind);
    const plane = sessionPlane(view.kind);
    if (plane === undefined) {
      continue;
    }
    const pending = view.starts - (ctx.providerClaimedStarts.get(view.kind) ?? 0);
    claimStart(ctx, plane, view.kind, pending);
  }
  return coveredKinds;
}

/** Provider-plane kinds no session-cap view covered — the spawned
 *  command's starts on each still draw on the provider lane (one
 *  claim per pending start, inside the kind's mutex). */
function claimUncoveredProviderStarts(ctx: CrossKindAdmit, coveredKinds: Set<string>): void {
  const providerPlaneKinds = new Set(ctx.providerGates.flatMap(g => [...g.providerPlaneKinds]));
  for (const kind of providerPlaneKinds) {
    if (coveredKinds.has(kind) || kind === ctx.quotaPlaneKind) {
      continue;
    }
    const plane = sessionPlane(kind);
    if (plane === undefined) {
      continue;
    }
    const starts = plane.startsSessions?.(ctx.spawnedCommand) ?? 0;
    const pending = starts - (ctx.providerClaimedStarts.get(kind) ?? 0);
    claimStart(ctx, plane, kind, pending);
  }
}

/** Admit every session a spawned command starts — the cross-kind
 *  claims a spawn owes beyond its own quota lane (which
 *  admitSessionSlot already covered). Claims land on `out` — custody
 *  is the caller's, released when the spawn unwinds or the committed
 *  row takes over the count. */
export function admitSpawnedCommandStarts(args: {
  spawnedCommand: string;
  agents: Record<string, Record<string, unknown>> | undefined;
  workerEnv: Record<string, string> | undefined;
  molStep: string | undefined;
  agentId: string;
  scope: string;
  liveByKind: Map<string, Set<string>>;
  /** the starts the provider passes already claimed, per kind — the
   *  union over every provider gate (one start claims once, so the
   *  gates' counts never overlap) */
  providerClaimedStarts: Map<string, number>;
  /** the provider gates this spawn resolved — a cross-kind start on a
   *  kind one covers still owes that lane's aggregate verdict */
  providerGates: readonly ProviderGate[];
  /** the spawn's own quota lane — its admit below covers the kind's
   *  full lane; the cross-kind loops must not double-claim it */
  quotaPlaneKind: string | undefined;
  /** reports a work-budget segment an admit just opened — the caller
   *  refunds them all when a later refusal unwinds the spawn */
  budgetCharged?: (kind: string) => void;
  out: string[];
}): void {
  const ctx: CrossKindAdmit = args;
  refuseOnCapPreflight(ctx);
  const coveredKinds = claimViewKindStarts(ctx);
  claimUncoveredProviderStarts(ctx, coveredKinds);
}
