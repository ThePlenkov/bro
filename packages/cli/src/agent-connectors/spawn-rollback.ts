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

/** The step context both claim undos compare-and-set against — the
 *  store a rewrite lands in, the step id, the post-spawn probe, and
 *  the beads dir whose actor name a fresh claim wrote. */
interface ClaimRollbackCtx {
  store: StepStore;
  molStep: string;
  now: StepProbe;
  beadsDir: string;
}

/** A rebind's undo — the bookkeeping wrote `actor`, then `claimAs`
 *  when the caller pinned one; restore the pre-spawn assignee only
 *  while the step still carries a name this spawn wrote (a claim
 *  another actor moved meanwhile is theirs, not ours to unbind). */
function restoreRebindAssignee(ctx: ClaimRollbackCtx, run: SpawnClaimRun): void {
  const prev = run.previousAssignee;
  const stillOurs =
    prev !== undefined && (ctx.now?.assignee === run.actor || ctx.now?.assignee === run.claimAs);
  if (stillOurs) {
    ctx.store.update(ctx.molStep, { assignee: prev });
  }
}

/** A fresh claim's undo — reopen only while the step still sits in
 *  the in_progress state this spawn's claimStep produced AND carries
 *  a name this spawn wrote: our actor, or the `claimAs` the
 *  bookkeeping rebound it to (a claim-on-behalf still counts — it is
 *  this spawn's fact to unbind, and skipping it would strand the bead
 *  in_progress under a name the dead run owned). */
function reopenFreshClaim(ctx: ClaimRollbackCtx, run: SpawnClaimRun): void {
  const ours =
    ctx.now?.assignee === (run.actor ?? bdActor(ctx.beadsDir)) ||
    (run.claimAs !== undefined && ctx.now?.assignee === run.claimAs);
  if (ctx.now?.status === 'in_progress' && ours) {
    ctx.store.reopen(ctx.molStep);
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
    const ctx: ClaimRollbackCtx = {
      store: taskStoreAt(beadsDir),
      molStep,
      now: probeStep(beadsDir, molStep),
      beadsDir,
    };
    // A blank previousAssignee is no assignee — bd writes '--assignee ''`
    // when the actor resolves empty, and treating it as a rebind target
    // would restore the empty string and strand the step in_progress.
    const rebind = run.claimed && run.previousAssignee !== undefined && run.previousAssignee !== '';
    if (rebind) {
      restoreRebindAssignee(ctx, run);
    } else if (run.claimed) {
      // A claimed step with no previous assignee was rebound from an
      // unassigned in-progress claim. Reopen it only while the claim still
      // carries this spawn's assignee; a successor may have taken it.
      reopenFreshClaim(ctx, run);
    } else if (!run.claimed) {
      reopenFreshClaim(ctx, run);
    }
  } catch {
    // best-effort — the 'lost' entry still names the failed run
  }
}

/** Undo the registry row a failed spawn wrote over `existing` —
 *  restore the row it replaced (a respawn keeps its predecessor's
 *  facts), or drop the fresh row so no dead spawn entry lingers.
 *  Only while the row is still THE ONE this spawn wrote — a respawn
 *  reuses the agentId but mints its own runId, so agentId alone
 *  cannot tell our row from a successor that landed first. */
export function restoreRegistryRow(args: {
  dir: string;
  molStep: string;
  agentId: string;
  /** the attempt token this spawn wrote into its row — the CAS
   *  identity a same-agentId respawn can never match */
  runId: string;
  existing: AgentRegistryEntry | undefined;
}): void {
  try {
    withAgentRegistryLock(args.dir, () => {
      const reg = readAgentRegistry(args.dir);
      const cur = reg[args.molStep];
      const foreign = cur === undefined || cur.agentId !== args.agentId || cur.runId !== args.runId;
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
