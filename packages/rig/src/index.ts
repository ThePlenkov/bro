export { rigNext, rigFocus, type RigNext } from './next.ts';
export {
  readyBeads,
  storeFor,
  NEVER_CLAIM_LABELS,
  type ReadyBead,
} from './ready.ts';

// --- policies: the lifecycle contract + first port (bro-u6fp5) ----------
export { type Policy } from './policy.ts';
export {
  convoyPolicy,
  runMol,
  runQueue,
  type ConvoyCtx,
  type ConvoyItem,
  type ConvoyPolicy,
  type MolResult,
  type MolVerdict,
  type RunArgs,
  type RunDeps,
} from './policies/convoy.ts';
export {
  clumpTitle,
  diskProbes,
  freshLoopQueue,
  loopPolicy,
  noteBead,
  runLoop,
  wallWaitUntil,
  loopWatch,
  stackPlan,
  type CeilingRes,
  type ItemResult,
  type LoopActCfg,
  type LoopCtx,
  type LoopDeps,
  type LoopLane,
  type LoopMember,
  type LoopPolicy,
  type LoopQueue,
  type LoopRunStamp,
  type LoopWork,
  type PushOutcome,
  type ServiceVerdict,
  type StackSlot,
  type WorkerRef,
} from './policies/loop.ts';

// --- fleet lifecycle: the ownership plane (bro-jamp7 slice 2) -------------
export {
  LIVE_MARKER_MS,
  agentOwner,
  agentProcessesIn,
  detailMatches,
  hooksDirOf,
  liveWorkDetails,
  liveWorkEntries,
  markerLive,
  markerOwner,
  ownerTag,
  processesRootedIn,
  registryEntryHoldsClaim,
  registryEntryState,
  type ProcHit,
  type WorkEntry,
} from './proc-owner.ts';
export {
  claimLockPath,
  isLinkedGitDir,
  worktreeClaim,
  worktreeClaimInfo,
  worktreeGitDir,
  worktreeIdleMs,
  type WorktreeClaimInfo,
} from './worktree-claim.ts';
export {
  acquireOccupancyLocks,
  branchSlug,
  freshOccupancy,
  greenOccupancy,
  occupied,
  occupancyProofs,
  registryAgents,
  retireOrphanedWorktree,
  supervisedBy,
  supervisorFresh,
  type FreshOccupancy,
  type OccProof,
  type OccupancyCtx,
} from './occupancy.ts';
export { ensureFixerWorktree } from './fixer-worktree.ts';
export {
  FIXER_LABEL,
  ensureFixerBead,
  fixerAttemptSpent,
  fixerBeadFor,
  fixerPrFromRef,
  fixerRef,
  recordFixerAttempt,
} from './fixer.ts';
export { REAP_STATES, selectReapable } from './reap.ts';
