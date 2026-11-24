/**
 * Spawn-write rollback — the two compare-and-set undos a failed
 * commitSpawn runs: the beads claim and the registry row. Each is
 * only rewritten while it still carries a fact THIS spawn wrote (a
 * claim another actor moved meanwhile is theirs, not ours to unbind;
 * a registry row a respawn already landed owns now). Every step is
 * best-effort — a rollback that fails leaves the 'lost' registry
 * entry the ordering promises, never a second thrown error masking
 * the first.
 *
 * Leaf module — imports externals only.
 */
import {
  type AgentRegistryEntry,
  bdActor,
  probeStep,
  readAgentRegistry,
  taskStoreAt,
  withAgentRegistryLock,
  writeAgentRegistry,
} from '@broject/core';

/** The claim facts a spawn's bookkeeping wrote — what its rollback
 *  must unbind. */
export interface SpawnClaimRun {
  claimed: boolean;
  actor: string | undefined;
  previousAssignee: string | undefined;
  claimAs: string | undefined;
}

type StepProbe = ReturnType<typeof probeStep>;
type StepStore = ReturnType<typeof taskStoreAt>;

/** A rebind's undo — the bookkeeping wrote `actor`, then `claimAs`
 *  when the caller pinned one; restore the pre-spawn assignee only
 *  while the step still carries a name this spawn wrote (a claim
 *  another actor moved meanwhile is theirs, not ours to unbind). */
function restoreRebindAssignee(
  store: StepStore,
  molStep: string,
  now: StepProbe,
  run: SpawnClaimRun
): void {
  const prev = run.previousAssignee;
  const stillOurs =
    prev !== undefined && (now?.assignee === run.actor || now?.assignee === run.claimAs);
  if (stillOurs) {
    store.update(molStep, { assignee: prev });
  }
}

/** A fresh claim's undo — reopen only while the step still sits in
 *  the in_progress/our-actor state this spawn's claimStep produced. */
function reopenFreshClaim(
  store: StepStore,
  molStep: string,
  now: StepProbe,
  beadsDir: string
): void {
  const stillOurs = now?.status === 'in_progress' && now.assignee === bdActor(beadsDir);
  if (stillOurs) {
    store.reopen(molStep);
  }
}

/** Undo the beads claim a failed spawn made — a phantom step carries
 *  none, so the caller skips this entirely for one. The claim is only
 *  rewritten while it still carries an assignee this spawn wrote: a
 *  rebind restores the pre-spawn assignee, a fresh claim reopens the
 *  step — each compare-and-set against the state its bookkeeping
 *  produced. */
export function rollbackSpawnClaim(beadsDir: string, molStep: string, run: SpawnClaimRun): void {
  try {
    const now = probeStep(beadsDir, molStep);
    const store = taskStoreAt(beadsDir);
    const rebind = run.claimed && run.previousAssignee !== undefined;
    if (rebind) {
      restoreRebindAssignee(store, molStep, now, run);
    } else if (!run.claimed) {
      reopenFreshClaim(store, molStep, now, beadsDir);
    }
  } catch {
    // best-effort — the 'lost' entry still names the failed run
  }
}

/** Undo the registry row a failed spawn wrote over `existing` —
 *  restore the row it replaced (a respawn keeps its predecessor's
 *  facts), or drop the fresh row so no dead spawn entry lingers.
 *  Only while the row still names OUR agentId — a respawn that
 *  already landed owns it now. */
export function restoreRegistryRow(args: {
  dir: string;
  molStep: string;
  agentId: string;
  existing: AgentRegistryEntry | undefined;
}): void {
  try {
    withAgentRegistryLock(args.dir, () => {
      const reg = readAgentRegistry(args.dir);
      const cur = reg[args.molStep];
      const foreign = cur === undefined || cur.agentId !== args.agentId;
      if (foreign) {
        return;
      }
      if (args.existing !== undefined) {
        reg[args.molStep] = args.existing;
      } else {
        delete reg[args.molStep];
      }
      writeAgentRegistry(args.dir, reg);
    });
  } catch {
    // best-effort — a row we cannot roll back is the same 'lost'
    // entry the ordering already tolerates
  }
}
