/**
 * Provider-gate start admission — the per-plane claim pass a provider
 * cap lane runs for a spawn (spec bro-x601l): every session the
 * provider's command would start draws on the lane, one claim per
 * plane per start, each judged inside the kind's admission mutex with
 * the lane's aggregate verdict riding.
 *
 * The plane-less lane's census is INJECTED by the caller — the
 * registry-occupant count lives in core (it reads the occupancy
 * probes), so it arrives as a callback this module runs inside the
 * provider mutex's locked section.
 *
 * Leaf module — imports externals + the session-admit gate shape.
 */
import {
  admitProviderSlot,
  admitSessionSlot,
  isBatchSpawn,
  type ProviderCapLane,
  providerCapHeldRefusal,
  type SessionPlane,
  SpawnError,
  sessionAdmissionLock,
  sessionReservationsDir,
  withAgentRegistryLock,
  withFileLock,
} from '@broject/core';
import { EMPTY_KEYS, type ProviderGate } from './session-admit.ts';

/** The admission context the provider-gate passes share — one spawn's
 *  identity plus the custody lists its claims land on. Mirrors the
 *  fields admitProviderGateStarts' args carry (its `startsCommand`
 *  resolves which command's sessions the planes count). */
export interface ProviderGateAdmit {
  agents: Record<string, Record<string, unknown>> | undefined;
  workerEnv: Record<string, string> | undefined;
  molStep: string | undefined;
  key: string;
  scope: string;
  liveByKind: Map<string, Set<string>>;
  /** reports a work-budget segment an admit just opened — the caller
   *  refunds them all when a later refusal unwinds the spawn */
  budgetCharged?: (kind: string) => void;
  /** The command whose starts this spawn admits — defaults to the
   *  provider's own entry command. */
  startsCommand?: string;
  /** Starts an earlier provider pass already claimed for this spawn,
   *  per kind — shared, not re-claimed: their sessions still count in
   *  this lane's aggregate census through the claims that already sit
   *  there. */
  claimedStarts?: ReadonlyMap<string, number>;
  /** per-plane claims — the caller's rollback/custody set */
  out: string[];
}

/** One provider plane's pending starts — claimed under the kind's own
 *  admission mutex, each carrying the lane's cap + aggregate census.
 *  Returns true when an earlier pass already claimed some of this
 *  plane's starts (the caller's shared-plane re-judge signal). */
export function claimGatePlaneStarts(
  gate: ProviderGate,
  plane: SessionPlane,
  args: ProviderGateAdmit,
  providerClaimedStarts: Map<string, number>
): boolean {
  // every session this spawn's command would start draws on the lane
  // — a multi-start command claims one slot per start. Starts an
  // earlier provider pass already claimed on this kind are shared,
  // not re-claimed — their sessions still count in this lane's
  // aggregate census through the claims that already sit there.
  const starts = plane.startsSessions?.(args.startsCommand ?? gate.providerCommand) ?? 1;
  const already =
    (args.claimedStarts?.get(plane.kind) ?? 0) + (providerClaimedStarts.get(plane.kind) ?? 0);
  const pending = Math.max(0, starts - already);
  for (let i = 0; i < pending; i++) {
    const claimed = admitSessionSlot(plane, args.agents, {
      key: args.key,
      molStep: args.molStep,
      workerEnv: args.workerEnv,
      scope: args.scope,
      liveKeys: args.liveByKind.get(plane.kind) ?? EMPTY_KEYS,
      providerCap: gate.providerCap,
      providerCensus: gate.providerCensus,
      ...(args.budgetCharged === undefined ? {} : { budgetCharged: args.budgetCharged }),
    });
    if (claimed !== undefined) {
      args.out.push(claimed);
      providerClaimedStarts.set(plane.kind, (providerClaimedStarts.get(plane.kind) ?? 0) + 1);
    }
  }
  return pending < starts;
}

/** A covered plane whose every start an earlier pass claimed: no new
 *  claim of ours carried this lane's verdict on those starts, so the
 *  cap is re-judged bare — inside a covered plane's admission mutex
 *  (the lock that serializes every other contender's claim against
 *  the same count), on the census the shared claims already sit in. */
export function rejudgeSharedProviderLane(
  gate: ProviderGate,
  sharedPlane: SessionPlane | undefined,
  providerClaimedStarts: ReadonlyMap<string, number>,
  agents: Record<string, Record<string, unknown>> | undefined
): void {
  const skip =
    sharedPlane === undefined ||
    providerClaimedStarts.size > 0 ||
    gate.providerCensus === undefined;
  if (skip) {
    return;
  }
  const census = gate.providerCensus as () => number;
  const resDir =
    gate.providerCap.reservationsDir ?? sessionReservationsDir(sharedPlane.kind, agents);
  withFileLock(
    sessionAdmissionLock(sharedPlane.kind, resDir),
    () => {
      const refusal = providerCapHeldRefusal(gate.providerCap, census());
      if (refusal !== undefined) {
        throw new SpawnError(refusal, 'cap', 'provider_cap');
      }
    },
    { label: `${sharedPlane.kind} provider lane re-check` }
  );
}

/** A plane-less provider's ledger admission — no plane counts this
 *  provider's command, so the namespaced claim ledger takes the
 *  verdict instead (spec bro-x601l: the registry fallback, the
 *  callback judged INSIDE the mutex). The census callback is the
 *  caller's — the registry-occupant count lives in core where the
 *  occupancy probes do.
 *
 *  LOCK ORDER: the census reaches the registry lock through the
 *  marker/handle sweeps, so the registry lock wraps the provider
 *  mutex here — every path is registry → provider (without it the
 *  orders invert: loop holds provider, spawn holds registry). */
export function admitPlanefreeProviderLane(args: {
  dir: string;
  workerEnv: Record<string, string> | undefined;
  key: string;
  providerCap: ProviderCapLane;
  /** the lane's live census — runs inside the locked section */
  census: () => number;
  /** ledger claims — the caller owns their custody */
  ledgerOut: string[];
}): void {
  const admission = withAgentRegistryLock(args.dir, () =>
    admitProviderSlot(args.providerCap, args.census, {
      key: args.key,
      lane: isBatchSpawn(args.workerEnv) ? 'batch' : 'interactive',
    })
  );
  if (admission === undefined) {
    return;
  }
  if (admission.refusal !== undefined) {
    throw new SpawnError(admission.refusal, 'cap', admission.capCause);
  }
  args.ledgerOut.push(...admission.paths);
}
