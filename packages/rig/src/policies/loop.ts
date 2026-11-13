/** `loopPolicy` — the loop scheduler as a rig policy (bro-u6fp5.1,
 *  spec bro-u6fp5.1.md). Moved verbatim from `commands/loop.ts` — the
 *  claim→worktree→spawn→gate FSM ran behind one concrete `Ctx`; this
 *  slice splits that context into the policy's own state (`LoopCtx`:
 *  config, queue, liveness) plus `LoopDeps` — every IO surface the
 *  command owns: the task store, review facade, agent registry,
 *  spawn/template lanes, stack edges, fleet PR listing, run records,
 *  and the say/error/out stream. The command keeps argv parsing,
 *  dry-run rendering, the audit sweep, and the deps wiring; the policy
 *  owns the lifecycle moments the parent spec names:
 *
 *    select  — the push pick: claimClump's candidate→lead→clump
 *              decision. The pick IS the claim — next.ts claimUpTo
 *              semantics make pick-and-commit atomic, so select
 *              performs the transition rather than reading ahead of
 *              it (the queue's claim is the item's entry into
 *              'claimed').
 *    onGate  — a member's settled PR snapshot → the memberAction
 *              dispatch (land/merge/closed/fix/rebase/update/wait/
 *              park) plus the merge finalize.
 *    onPark  — parkBeads + leave(m,'parked') — the defer/release row
 *              every member park shares.
 *    onLost  — the worker-'lost' settle: wall wait, retry, park,
 *              failed, closed, or the PR the dead worker opened and
 *              the member joins its own gate.
 *
 *  'kept'/'active' are cadence verdicts the driver consumes, not
 *  lifecycle transitions. `serviceMember`/`servicePass`/`tryClaim`/
 *  `pushItem`/`run` ride along as the policy's own drivers — the
 *  Policy interface names lifecycle moments; the driver is the
 *  policy's engine (the same contract convoyPolicy sets). */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  type FetchPrActStateOpts,
  gatePending,
  type PrStateCache,
  resolveLedger,
  watchBegin,
  watchEnd,
  watchRefresh,
} from '@broject/act';
import {
  type AgentConnector,
  type AgentInfo,
  AgentNotFound,
  type AgentState,
  agentExitFileName,
  agentRegistryPath,
  bdActor,
  bodyMeta,
  emitLifecycle,
  getTasks,
  gitBranchLog,
  gitCommonDir,
  gitTry,
  isAgentCause,
  issueLink,
  LockTimeout,
  type MirrorPolicy,
  mkdirPrivateSync,
  patchAgentRegistryIf,
  pidAlive,
  probeStep,
  procStat,
  type ProviderWall,
  readAgentRegistry,
  type ReviewFacade,
  releaseSessionSlot,
  releaseSessionStart,
  SpawnError,
  type SpawnSpec,
  type SpawnWorker,
  stampPrOwnership,
  type TaskStore,
  wallText,
  withFileLock,
  worktreePathFor,
  writePrivateFileSync,
} from '@broject/core';
import {
  beadForHead,
  buildFixPrompt,
  buildRebasePrompt,
  buildWorkPrompt,
  ceilingHeld,
  clumpMembers,
  coveredBeadIds,
  type DiskProbe,
  diskFloorBreach,
  diskFloorBytes,
  type FleetPrRow,
  type GateSnapshot,
  isFleetHead,
  type LoopConfig,
  type LoopItem,
  loopSlug,
  MB,
  memberAction,
  orphanVerdict,
  planItem,
  projectBeads,
  type ReconcileBead,
} from '@broject/loop';
import { rigNext } from '../next.ts';
import type { Policy } from '../policy.ts';
import { processesRootedIn } from '../proc-owner.ts';
import type { ReadyBead } from '../ready.ts';

// --- the split context ---------------------------------------------------------

/** The act gate's own section, narrowed to the knobs the service pass
 *  reads — the command's `bro.config act` section satisfies it
 *  structurally (it feeds the same fetchPrActState opts verbatim). */
export type LoopActCfg = Pick<
  FetchPrActStateOpts,
  'ignoreChecks' | 'maxRounds' | 'docsPaths' | 'docsMaxRounds' | 'requireApproval' | 'approvers'
>;

/** The run record a claim stamps for custody — the loop-pid owner
 *  marker `beginLoopRun` persists until the worker's own spawn
 *  re-stamps it (bro-ho09d). Shape-identical to the command's
 *  LoopRunRecord so the dep impl passes it straight through. */
export interface LoopRunStamp {
  beadId: string;
  /** the whole claimed clump — a batch's members share the lead's
   *  worker and record */
  beadIds?: string[];
  slug: string;
  pid: number;
  pidStart?: string;
  startedAt: string;
  worktree: string;
  log: string;
}

/** Every IO surface the loop FSM touches, injected by the command.
 *  Object deps are the live facades (task store, review host, agent
 *  connector, mirror, spec probe); function deps are the command's
 *  own adapters — spawn lanes, stack edges, fleet PR listing, run
 *  records, and the output stream. Nothing here reaches back into a
 *  command module, so the policy stays acyclic. */
export interface LoopDeps {
  /** The serving tasks backend — all bead mutations go through it. */
  tasks: TaskStore;
  /** Review facade bound to the main checkout. */
  rev: ReviewFacade;
  /** The agents facade connector workers spawn through — undefined
   *  only when no beads dir pins a registry claim plane (the awaited
   *  spawn keeps the serial semantics there). */
  agents?: AgentConnector;
  /** The shared gate-state feed — every member's service tick reads
   *  it, so loop's polls plus watch/drive/act-wait passes share one
   *  fetch per PR per TTL window (bro-0tcrl). */
  stateCache: PrStateCache | null;
  /** The tracker projection target — undefined = no projection
   *  (spec bro-z2z7f). */
  mirror?: TaskStore;
  /** Spec probe for the projection's specLinked rule. */
  specHas: (id: string) => boolean;
  /** Human-readable line — stderr under --json, stdout otherwise. */
  say: (msg: string) => void;
  /** Diagnostic line — always stderr. */
  error: (msg: string) => void;
  /** Raw stdout line — the --json event stream's sibling. */
  out: (line: string) => void;
  /** One --json event row. */
  emitJson: (row: unknown) => void;
  now: () => number;
  sleepMs: (ms: number) => Promise<void>;
  /** Sweep crashed runs' records before the first claim. */
  reapRuns: () => void;
  beginRun: (rec: LoopRunStamp) => void;
  endRun: (slug: string) => void;
  runLog: (slug: string) => string | null;
  /** The project scope the queue claims under — null when the
   *  prefix lookup fails (reported once by the impl). */
  projectScope: () => unknown;
  /** The ready queue's claimable slice for this scope — ready beads
   *  minus seen, foreign-scope counted aside. */
  claimCandidates: (
    seen: Set<string>,
    scope: unknown
  ) => { candidates: ReadyBead[]; foreign: number };
  /** Claim up to n beads — the store's own claim semantics. */
  claimUpTo: (beads: ReadyBead[], n: number) => ReadyBead[];
  /** Per-bead spawn lane resolution (class label → route table →
   *  provider chain → the fleet.matrix pick). Throws the host's
   *  matrix-hold error on an enforce no-fit — `matrixHold` recognizes
   *  it so the policy can park the clump instead of failing the pick
   *  (spec bro-v0pvd.1.1). */
  laneFor: (bead: ReadyBead) => Promise<LoopLane>;
  /** True when a laneFor throw is the fleet.matrix hold — the error
   *  class lives host-side (agent-connectors), so the policy asks
   *  rather than imports. */
  matrixHold: (err: unknown) => boolean;
  /** Registry spawn — detached worker through the agents facade. */
  spawnWorker: (member: LoopMember, prompt: string) => Promise<void>;
  /** Raw-template spawn — the awaited `sh -c` fallback. */
  spawnTemplate: (
    lane: LoopLane,
    beadIds: string[],
    title: string,
    promptFile: string,
    dir: string,
    agentId?: string
  ) => Promise<number | null>;
  /** Session-quota admission for a template spawn. */
  admitTemplate: (
    lane: LoopLane,
    spec: { molStep: string; prompt: string; repoRoot: string },
    key: string
  ) => { reservation: string | undefined; crossKind: string[] };
  /** The provider's wall row, when one is recorded. */
  providerWall: (provider: string) => ProviderWall | undefined;
  /** The operator's worktree bootstrap command — spawnSync-shaped
   *  result so the settle can name status/signal. */
  bootstrap: (worktreeDir: string) => { status: number | null; signal: NodeJS.Signals | null };
  /** `act merge` on the member's PR. */
  mergePr: (pr: number) => Promise<unknown>;
  /** Settle a merged member's ACP sessions in its worktree. */
  settleSessions: (worktreeDir: string) => void;
  /** Flow a terminal non-merge verdict back to the router. */
  reportOutcome: (beadId: string, result: 'failed' | 'parked') => Promise<void>;
  /** Post-merge stack retarget lines — empty when no stack is armed. */
  syncStackLines: () => string[];
  /** The bead's stack slot (member number, base, edge) — undefined
   *  outside --stack mode or for an unstacked bead. */
  stackSlotFor: (bead: ReadyBead) => StackSlot | undefined;
  /** The stack push lock path — null when no stack is armed or the
   *  common dir can't resolve. */
  stackLockPath: () => string | null;
  /** Record a stack edge (branch → base) for merge ordering. */
  recordStackEdge: (branch: string, base: string) => void;
  /** The repo's default branch name, when resolvable. */
  defaultBranch: () => string | undefined;
  /** `git worktree list --porcelain` parsed — null when the listing
   *  fails (callers treat it as best-effort). */
  worktrees: () => { branch?: string; path: string }[] | null;
  /** Open fleet PRs (work/loop/stack/fix heads) — null when the host
   *  can't list (fail-closed ceiling input). */
  openFleetPrs: () => FleetPrRow[] | null;
  /** The end-of-run audit — tails, litter, claims, summary. */
  finishAudit: () => void;
}

/** The policy's own state — everything the FSM mutates that is not an
 *  IO surface: config, the per-run queue, liveness stage/bead, and
 *  the claim-scope the driver resolved. The command's Ctx extends
 *  this so heartbeat/audit read the same fields the policy writes. */
export interface LoopCtx {
  deps: LoopDeps;
  cfg: LoopConfig;
  act: LoopActCfg;
  intervalS: number;
  json: boolean;
  /** The serving tasks backend name — beads-only tails engage only
   *  on 'beads'. */
  backend: string;
  repo: string;
  root: string;
  /** The beads dir pinned into agent/bootstrap env as BEADS_DIR. */
  beadsDir?: string;
  /** `bro loop --stack <name>` — each claimed bead becomes a member
   *  of the named stack. */
  stack?: string;
  /** Cease claiming new work — only service gate stack + reconcile. */
  claimsHeld?: { open: number; max: number };
  /** Cleanup failures collected during the run — the end-of-run
   *  audit prints them again. */
  tails: string[];
  /** Liveness — the stage the run is suspended on. */
  stage: string;
  /** The bead currently in play — undefined between items. */
  bead?: string;
  /** The projection policy — bro.config `mirror`, defaults applied. */
  mirrorPolicy: MirrorPolicy;
  /** Per-run queue state — reset by `run` on each invocation. */
  q: LoopQueue;
  /** The claim scope `run` resolved — the claim pick reads it through
   *  `deps.claimCandidates`. */
  scope?: unknown;
}

/** The lifecycle item union the Policy verbs narrow — a claimed clump
 *  is what `select` returns; a serviced member is what the gate verbs
 *  take. Callers always pass the matching arm. */
export type LoopWork = LoopMember | ReadyBead[];

/** Clickable PR ref for this repo — user-facing lines never print
 *  bare #N (the AGENTS.md PR-links rule). */
const prRef = (ctx: LoopCtx, pr: number): string => ctx.deps.rev.prLink(ctx.repo, pr);
export type ItemResult = 'landed' | 'closed' | 'parked' | 'failed';

/** The store dir the loop's own taskStore calls resolve to — the
 *  backend's `dataDir` (`bd where` for beads). Pinned into spawned envs
 *  as BEADS_DIR — a worktree-local .beads (tracked copy, stale
 *  checkout) or a bd too old for common-dir discovery would otherwise
 *  fork bead state: the agent's close/update lands in a db that dies
 *  with the worktree and the bead re-surfaces phantom-open in main. */

export interface LoopLane {
  worker?: SpawnWorker;
  /** Resolved provider name + model — provenance pins and reporting
   *  (`bro agents up` prints the same pair). */
  provider?: string;
  account?: string;
  model?: string;
  /** The routing lane the spawn resolved to (fleet.routing class — spec
   *  bro-1x7p). Provenance like provider/model; absent on unrouted
   *  spawns (no fleet.routing declared). */
  class?: string;
  /** The fleet.matrix lane the spawn routed to (enforce pick's row
   *  name — spec bro-v0pvd.1.1); absent on shadow/off/unrouted lanes. */
  matrix?: string;
  route?: NonNullable<SpawnSpec['route']>;
  /** The route-table decision's UUID — journaled at decision time;
   *  pinned on the bead (`router:decision=`), the worker env
   *  (BRO_ROUTER_DECISION) and the outcome report's join key (spec
   *  bro-0ykhg.4). */
  decisionId?: string;
}

export function wallWaitUntil(
  cause: string | undefined,
  resetAt: string | undefined,
  now: number,
  waits: number = 0
): number | undefined {
  if (cause !== 'rate_limited') {
    return undefined;
  }
  const reset = typeof resetAt === 'string' ? Date.parse(resetAt) : Number.NaN;
  if (Number.isNaN(reset)) {
    return undefined;
  }
  if (reset > now) {
    return reset;
  }
  // stale reset — pace it
  const n = typeof waits === 'number' && Number.isFinite(waits) ? waits : 0;
  const exp = Math.max(0, n - 1);
  let floor = 30_000 * Math.pow(2, exp);
  const cap = 15 * 60_000;
  if (floor > cap) {
    floor = cap;
  }
  return now + floor;
}

export function loopWatch(
  pr: number,
  link: string,
  workdir: string,
  cfg: Pick<LoopConfig, 'stallMin' | 'mergeTimeoutMin' | 'fixRounds'>
) {
  return {
    pr,
    link,
    merge: true,
    cleanup: true,
    workdir,
    timeoutMin: (cfg.stallMin + cfg.mergeTimeoutMin) * (cfg.fixRounds + 1),
  };
}

const WORKER_POLL_MS = 1_000;

/** Alive-line floor: the heartbeat surfaces a STUCK run, so a fast
 *  --interval tick must not turn it into per-poll noise — a sub-floor
 *  interval (the e2e's fake clock) would heartbeat constantly through
 *  every healthy run. The floor still beats inside a bounded hold —
 *  a stalled run must name its stall promptly, and the e2e's 4s
 *  kill-windows rely on seeing the line. Production is unchanged:
 *  the default 60s interval sits far above the floor. */

export interface WorkerRef {
  agentId: string;
  runId?: string;
  spawnedAt?: string;
  /** ms stamp at our spawn call — the crash window's start. */
  spawnedMs: number;
  pid?: number;
}

/** The push half of the alternation: claim → worktree → agent → PR.
 *  `beads` is the claimed clump — a solo claim is a one-element array.
 *  The PR found joins the gate stack as the newest member; every
 *  no-PR outcome settles inline exactly as the serial loop did. */

export interface LoopMember {
  beads: ReadyBead[];
  item: LoopItem;
  /** The PR this member gates on — undefined while its FIRST worker is
   *  still running (spec bro-zpa93): the member is pushed the moment
   *  the spawn registers and joins the gate when the .exit lands. */
  pr?: number;
  /** The in-flight registry worker — set at push and again on every
   *  fix/rebase respawn; cleared when its exit record lands. */
  worker?: WorkerRef;
  /** The lane resolved at push — fix/rebase respawns reuse it. The
   *  member's class was settled before its worktree existed (config
   *  and bead labels are read once, never refreshed mid-run), so
   *  re-resolving in a round can only re-hit the same route error —
   *  silently burning a round per poll — or drift the lane mid-tenure. */
  lane: LoopLane;
  /** watchBegin marker path — armed for the member's whole stack
   *  tenure: a dead loop leaves a dead marker `act rearm` resurrects
   *  as `act wait --merge --cleanup` in the member's worktree. */
  marker: string | null;
  /** Gate (re-)entry ms — a fix/rebase round resets the budget. */
  since: number;
  /** When this member may be polled again — a 'kept' verdict stamps
   *  its stage's own cadence (worker: WORKER_POLL_MS; gate: intervalS),
   *  so a fast worker wake can't drag a PR gate into hot host polls. */
  nextPollAt?: number;
  /** Agent respawns consumed — fix and rebase rounds share the
   *  loop.fixRounds bound. */
  rounds: number;
  /** headSha an update-branch push last moved — the landing check. */
  updatedSha?: string;
  /** Consecutive fetch failures — parks at the old wait's 3. */
  fetchErrors: number;
  /** Consecutive thrown service failures — the settle-side twin of
   *  fetchErrors: the fetch arms own fetchErrors end-to-end (they
   *  increment on a failed read and reset on a good one), so a throw
   *  escaping serviceMember strikes here instead — sharing the counter
   *  let each side's resets zero the other's strikes (bro-cu3q8). */
  serviceErrors: number;
  /** Wall wait expiry (ms) — a rate_limited death carrying a parseable
   *  resetAt arms this and the member waits instead of respawning
   *  (bro-36bhc). Cleared on expiry/respawn. */
  wallWaitUntil?: number;
  /** Consecutive wall deaths on this member — drives the escalating
   *  stale-reset floor. */
  wallWaits?: number;
  /** The work prompt the spawn wrote — retained so a wall expiry can
   *  respawn the same work order without rebuilding it. */
  prompt?: string;
  /** Transient — serviceWorker stamps the terminal poll's facts here
   *  before delegating the settle to the policy's onLost verb; read
   *  only inside onLost right after being stamped. */
  lost?: {
    agentId: string;
    spawnedMs: number;
    info: AgentInfo | undefined;
    exit: { code: number | null; at: number };
    state: AgentState;
    superseded: boolean;
  };
}

/** The registry handle a pending member polls — `spawnedAt` is the
 *  generation stamp: a respawned same-id entry is a NEW worker, not the
 *  one the member is waiting on, and must not inherit this clock. */

export type PushOutcome =
  | { kind: 'member'; member: LoopMember }
  /** settled — the leave() lifecycle row already ran inside
   *  serviceWorker; settleOutcome still tallies/parks the claims but
   *  must not emit a second park row for the same beads */
  | { kind: 'done'; result: ItemResult; settled?: true }
  /** untilMs — a provider wall's reset: pushes hold until the wall
   *  lifts instead of re-probing every interval (bro-36bhc). */
  | { kind: 'hold'; why: string; untilMs?: number }
  /** 'unavailable' refusals are infra — the pick holds and retries
   *  next tick instead of parking (spec bro-cu3q8). */
  | { kind: 'infra'; why: string };

/** The loop's watch payload for one member PR — `merge` + `cleanup`
 *  record the promise the loop is keeping (its own merge, its own
 *  worktree retire); `timeoutMin` bounds the marker's TTL to the item's
 *  worst case — every fix round paying both budgets (the agent leg
 *  prices at stallMin, the only agent-minutes knob left since the
 *  wall-clock kill went advisory in bro-9lpn3) — so a marathon member
 *  can't TTL-prune its own supervision marker mid-tenure. */

export type ServiceVerdict = 'kept' | 'active' | ItemResult;

/** A pending worker's poll cadence — the registry/.exit probe is a
 *  LOCAL read, not a review-host fetch, so it polls far faster than
 *  the gate interval and a long worker still settles within a second
 *  of its exit landing (spec bro-zpa93). */

export interface StackSlot {
  /** Position the bead occupies (or joins at). */
  n: number;
  /** Creation/prompt base — the live tip's branch, the recorded edge,
   *  or the default branch for a bottom member. */
  base?: string;
  /** The stack edge to record — set only for a fresh member whose base
   *  is another stack branch. */
  edge?: string;
  /** True when the member sits directly on the default branch. */
  bottom: boolean;
}

/** The stack slot a claimed bead takes. A bead already in the stack
 *  (failed/parked retry, parked member) re-enters ITS member branch —
 *  re-deriving `n` from the tip would plan a phantom `stack/<name>/<n'>-`
 *  branch while the surviving worktree sits on the old one. A new bead
 *  joins at the live tip — merged members are skipped so the chain
 *  never forks from a dead (already-merged) branch. */

export interface CeilingRes {
  pid: number;
  pidStart?: string;
  branch?: string;
  ts: number;
}

const CEILING_RES_PREFIX = 'res-';

/** Count admitted-but-PR-less claims across loops sharing this common
 *  dir — and collect the ones already discharged. Consumed: the
 *  branch's PR now lists (the listing counts it). Released: the owner
 *  pid is dead (its claim can never spawn). Anything else — alive
 *  owner, branch not yet listed, unreadable file — counts: an
 *  unverifiable reservation is a held slot, never a free one. */

const TASK_LIST_SNAPSHOT_CAP = 1000;

/** Build slug -> bead map for reconcile. Returns null if the listing is unknown. */

export interface LoopQueue {
  /** Beads already attempted this run — never re-picked. */
  seen: Set<string>;
  /** The ordered gate stack — entry order is service priority. */
  stack: LoopMember[];
  tally: { landed: number; closed: number; parked: number; failed: number };
  /** Claims spent — --max bounds claims, not outcomes: a claimed bead's
   *  verdict arrives whenever its gate settles. */
  claimed: number;
  /** claimClump returned nothing — no more pushes, only gate service. */
  drained: boolean;
  /** Beads this run deliberately parked — a park is intent, not an
   *  orphan, so the end-of-run litter sweep must not release their
   *  claims (bro-ho09d). The claim is now a deferred snooze
   *  (bro-hl22w), so the guard's real job is the park whose defer write
   *  failed and still holds in_progress. A later sweep judges them
   *  fresh. */
  parkedClaims: Set<string>;
  /** A spawn refused on a full fleet holds pushes until now — a
   *  hot-loop through pick+probe+spawn would burn the tick against
   *  the same wall (spec bro-zpa93). */
  pushHoldUntil: number;
  /** The disk floor's transition edge — the held/resumed lines say
   *  once per episode, not once per tick (spec bro-2spp7). */
  diskHeld: boolean;
  /** A member sitting in a wall wait holds pushes — the transition
   *  edge for the once-per-episode line (bro-36bhc). */
  wallHeld: boolean;
  /** Consecutive tick failures past the member/claim boundaries — the
   *  count rides the stage so a held run names its stall on the
   *  heartbeat (spec bro-cu3q8). */
  infraErrors: number;
  /** The stage an infra-held push carries — set by holdForInfra and the
   *  last-resort catch, cleared when a tick reaches the claim section
   *  unheld, so the idle heartbeat names the wedged backend instead of
   *  a silent 'idle' (spec bro-cu3q8). */
  holdStage?: string;
  /** statfs paths that already reported a probe failure — one warning
   *  per path per run, then the watermark goes blind-quiet. */
  diskProbeWarned: Set<string>;
  /** Fleet PRs whose host can't close — reported once per run, not
   *  once per pass (the reconcile retries every tick). */
  unclosableNoted: Set<number>;
  /** Branch → ceiling reservation file — released when the member
   *  leaves the stack; an open PR on the branch consumes it earlier
   *  via the fleet listing. */
  ceilingRes: Map<string, string>;
}

/** The widest listing cap a TaskStore backend can silently impose —
 *  the github task store stops at QUERY_CAP (packages/github/
 *  src/tasks.ts) and returns the truncated page as a complete
 *  snapshot. A full page is indistinguishable from a huge store, and
 *  either way a reconcile on it can bury PRs whose live beads fell
 *  past the cap — so a capped read answers 'unknown', not 'complete'.
 *  The reconcile is an optimization; skipping it closes nothing. */

export function noteBead(ctx: LoopCtx, id: string, note: string): void {
  try {
    ctx.deps.tasks.update(id, { notes: note });
  } catch {
    ctx.deps.error(`loop: could not note ${id} — ${note}`);
  }
}

/** The projection stamp (spec specs/backends/bro-z2z7f) — at the
 *  PR-armed moment each bead mirrors to a tracker item and the PR
 *  body wires the auto-close. Every leg is best-effort: the PR is the
 *  artifact; the board is a read-model — a tracker miss never blocks
 *  the member. */

function reopenBead(ctx: LoopCtx, id: string): void {
  try {
    // release only a claim that is ours to release — `bd update
    // --assignee ''` is unconditional, so a foreign assignee (another
    // runner, a rebinding guard probe) keeps its bead. An empty or
    // unresolvable actor keeps the claim marker's word (fail-open):
    // it cannot prove a claim foreign against an identity space it
    // cannot read.
    const actor = ctx.deps.tasks.actor?.() ?? '';
    const assignee = ctx.deps.tasks.get(id)?.assignee ?? '';
    if (actor !== '' && assignee !== '' && assignee !== actor) {
      ctx.deps.say(`loop: ${id} kept — claimed by ${assignee}, not ours to release`);
      return;
    }
    ctx.deps.tasks.reopen(id);
    emitLifecycle(ctx.root, {
      kind: 'release',
      bead: id,
      from: 'in_progress',
      to: 'open',
      detail: { via: 'loop' },
    });
  } catch {
    /* best-effort unclaim */
  }
}

/** The park settle (spec bro-hl22w): the site note names the wall, then
 *  each still-open bead is deferred — bd's snooze — with
 *  `parkedWakeMin`'s cooldown and its assignee cleared. A park that only
 *  notes leaves the bead in_progress under a dead owner: invisible to
 *  ready/next/loop forever, a silent backlog stall (the bug this
 *  closes). Deferred rows hide from ready — the park's whole point: the
 *  next claim must not re-claim straight into the same wall — and wake
 *  to open on the first ready read past the horizon (the TaskStore
 *  port performs that lazy wake; `bd undefer` releases one early).
 *  `parkedWakeMin` 0 = the indefinite icebox. The worktree stays: the
 *  woken claim's planItemAndWorktree reuses it. A store that rejects
 *  the write (down, or a backend with no defer concept) keeps the old
 *  claim-hold — best-effort, never a crash.
 *
 *  `wakeAtMs` overrides the cooldown with an absolute wake stamp — a
 *  provider-reported rate-limit reset is exactly that: the park exists
 *  to wait the wall out, so the snooze IS the reset (bro-36bhc — the
 *  convoy-run wait contract; a 2h cooldown would outlive a 15-minute
 *  wall and undershoot a 6-hour one). A past/stale stamp collapses to
 *  an immediate wake.
 *
 *  Returns the members whose defer write FAILED — they remain
 *  in_progress under this run's claim, so the caller must keep (or
 *  otherwise settle) their custody record rather than reporting a
 *  clean park (a deferred bead needs no owner; a claimed one does). */

function parkBeads(ctx: LoopCtx, beads: ReadyBead[], msg: string, wakeAtMs?: number): ReadyBead[] {
  // parkedWakeMin has no natural ceiling — an absurd value overflows the
  // clock into a toISOString() RangeError BEFORE the per-bead catch,
  // aborting the park and leaving claims in progress. Past a decade the
  // operator's intent is the icebox anyway, so clamp the snooze there.
  const PARKED_WAKE_CAP_MIN = 10 * 365 * 24 * 60;
  const wakeCapMs = ctx.deps.now() + PARKED_WAKE_CAP_MIN * 60_000;
  const min = Math.min(ctx.cfg.parkedWakeMin, PARKED_WAKE_CAP_MIN);
  const patch: Record<string, string | number> =
    wakeAtMs !== undefined && Number.isFinite(wakeAtMs)
      ? {
          defer: new Date(Math.min(Math.max(wakeAtMs, ctx.deps.now()), wakeCapMs)).toISOString(),
          assignee: '',
        }
      : min > 0
        ? { defer: new Date(ctx.deps.now() + min * 60_000).toISOString(), assignee: '' }
        : { status: 'deferred', assignee: '' };
  const failed: ReadyBead[] = [];
  for (const b of openBeads(ctx, beads)) {
    noteBead(ctx, b.id, msg);
    try {
      ctx.deps.tasks.update(b.id, patch);
    } catch (err) {
      ctx.deps.error(`loop: could not defer ${b.id} — ${String(err)}`);
      failed.push(b);
    }
  }
  return failed;
}

/** One `bd show` batch answers the whole clump's statuses — a store
 *  blip or a missing row answers 'unknown' for that member, so callers
 *  keep the still-open contract and a blip never masks work. */

function beadStatuses(ctx: LoopCtx, beads: ReadyBead[]): Map<string, string> {
  const out = new Map<string, string>();
  let found: Map<string, string>;
  try {
    found = new Map(
      getTasks(
        ctx.deps.tasks,
        beads.map(b => b.id)
      ).map(r => [r.id, r.status ?? 'unknown'])
    );
  } catch {
    found = new Map();
  }
  for (const b of beads) {
    out.set(b.id, found.get(b.id) ?? 'unknown');
  }
  return out;
}

/** The members of a clump still open in the store — verdict closes the
 *  agent already landed stay closed. One bulk read per clump; only a
 *  positively-closed row filters a member out, so a missing row or a
 *  thrown read keeps the 'unknown' = still-open contract. */

function openBeads(ctx: LoopCtx, beads: ReadyBead[]): ReadyBead[] {
  try {
    const closed = new Set(
      getTasks(
        ctx.deps.tasks,
        beads.map(b => b.id)
      )
        .filter(r => r.status === 'closed')
        .map(r => r.id)
    );
    return beads.filter(b => !closed.has(b.id));
  } catch {
    return beads; // a store blip must not mask work
  }
}

/** The clump's own commit log — messages on the member branch since it
 *  forked from its PR base. Coverage is evidence: only beads a commit
 *  names count as resolved (spec bro-nspj7). Preferred head is the PR's
 *  pushed headSha — exactly what merged, so local-only commits can't
 *  over-cover; a remote-only head (update-branch merge) falls back to
 *  the worktree tip. Empty string when the log is unreadable — callers
 *  treat unknown coverage as "nothing covered", the fail-safe direction
 *  (a re-queue, never a false close). */

function agentVerdict(
  ctx: LoopCtx,
  beads: ReadyBead[],
  worktreeDir: string
): ItemResult | undefined {
  const statuses = beadStatuses(ctx, beads);
  const closed = beads.filter(b => statuses.get(b.id) === 'closed');
  if (closed.length === 0) {
    return undefined;
  }
  for (const b of closed) {
    ctx.deps.say(`loop: ${b.id} closed by the agent — verdict, not a failure`);
    noteBead(ctx, b.id, `loop: closed by agent verdict — worktree ${worktreeDir} kept for audit`);
    emitLifecycle(ctx.root, {
      kind: 'close',
      bead: b.id,
      to: 'closed',
      detail: { via: 'loop', verdict: 'agent' },
    });
  }
  return closed.length === beads.length ? 'closed' : undefined;
}

/** Agent exited without a PR — note + reopen every member still open,
 *  'failed'. A batch member's own `bd close` verdict stands. */

function failNoPr(
  ctx: LoopCtx,
  beads: ReadyBead[],
  item: LoopItem,
  code: number | null
): ItemResult {
  for (const b of openBeads(ctx, beads)) {
    noteBead(
      ctx,
      b.id,
      `loop: agent exited ${code ?? 'abnormal'} without a PR — worktree kept at ${item.worktreeDir}`
    );
    reopenBead(ctx, b.id);
  }
  return 'failed';
}

/** Optional bootstrap command — false (with the beads noted + reopened)
 *  when it fails; spawning the agent on a half-set-up worktree is worse
 *  than failing fast. */

function settleNoPr(
  ctx: LoopCtx,
  beads: ReadyBead[],
  item: LoopItem,
  code: number | null,
  elapsed: number
): ItemResult {
  const verdict = agentVerdict(ctx, beads, item.worktreeDir);
  if (verdict !== undefined) {
    return verdict;
  }
  if (ctx.cfg.crashExitMs > 0 && elapsed < ctx.cfg.crashExitMs) {
    // gone in seconds, no PR, no verdict — the spawn died on the
    // environment (broken dist, bad argv), never on the bead. Reopen
    // and the next claim walks into the same wall: claim → crash →
    // reopen → reclaim is the respawn-burn from bro-sovl3. Park loud —
    // the snooze hides it for the cooldown, not the queue forever.
    parkBeads(
      ctx,
      beads,
      `loop: agent gone in ${elapsed}ms (exit ${code ?? 'spawn failure'}) — environment crash, not a verdict; parked — worktree kept at ${item.worktreeDir}`
    );
    ctx.deps.say(
      `loop: ${beads[0]!.id} agent exited ${code ?? 'spawn failure'} in ${elapsed}ms — parked (crash, not work)`
    );
    return 'parked';
  }
  return failNoPr(ctx, beads, item, code);
}

/** A service verdict — 'kept' parks the member until its nextPollAt
 *  (a quiet wait, or a worker still running); 'active' keeps it too
 *  but asks the scheduler for an immediate re-poll — a fix/rebase/
 *  update just moved the gate, or a worker's exit record just landed.
 *  The rest are ItemResult settles that splice it out. */

export function clumpTitle(beads: ReadyBead[]): string {
  return beads.length > 1 ? `${beads[0]!.title} (+${beads.length - 1} more)` : beads[0]!.title;
}

/** An agent that exits without a PR may still have left verdicts — each
 *  `bd close` lands in the shared store (BEADS_DIR pin). Closed means
 *  "nothing to ship"; reopening it would resurrect the phantom. A failed
 *  status probe falls through to the failure path rather than masking
 *  it. ALL members closed → the whole clump is a verdict; a partial
 *  close still counts — the unclosed tail falls through to requeue. */

function writePrompt(item: LoopItem, text: string): void {
  mkdirPrivateSync(dirname(item.promptFile));
  writePrivateFileSync(item.promptFile, text);
}

function ensureWorktree(root: string, branch: string, dir: string, base?: string): void {
  if (existsSync(dir)) {
    return; // a previous run's worktree survived — reuse it
  }
  if (base === undefined) {
    gitTry(['-C', root, 'fetch', 'origin', 'main', '--quiet']);
    base = ['origin/main', 'main', 'HEAD'].find(
      r => gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', r]).code === 0
    );
  }
  const add = gitTry(['-C', root, 'worktree', 'add', '-b', branch, dir, base ?? 'HEAD']);
  if (add.code !== 0) {
    // branch may already exist from a previous run — attach to it
    const retry = gitTry(['-C', root, 'worktree', 'add', dir, branch]);
    if (retry.code !== 0) {
      throw new Error(`git worktree add failed: ${retry.err || add.err}`);
    }
  }
}

/** Spawn the agent in the worktree and await its exit — there is no
 *  timer and no kill path (spec bro-9lpn3): a worker's lifetime is the
 *  orchestrator's decision, taken at check-in from the run record, never
 *  by a wall clock inside the spawn. The child still runs `detached`
 *  (own process group) so a terminal interrupt of `bro loop` can't
 *  group-signal a mid-write worker — interrupting the loop is an
 *  accident, not an orchestration decision.
 *
 *  `beadIds` is the whole claimed clump — a solo claim is a
 *  one-element list (spec bro-nspj7); the run record, log slug, and
 *  provenance pins key off the lead (`beadIds[0]`). `lane` is the
 *  clump's resolved spawn lane — with fleet.routing declared it can
 *  differ bead to bead (spec bro-1x7p).
 *
 *  stdout/stderr go straight to `<git-common>/bro/loop/<slug>.log`
 *  (append — fix rounds continue the same trail), and the spawn leaves a
 *  `<slug>.json` record beside it: pid/pidStart for liveness, the log's
 *  mtime as the last-progress signal `bro watch`/`bro status` report
 *  silence from. A file fd, not a pipe — a dead loop must not turn the
 *  worker's next write into a SIGPIPE kill, and the transcript survives
 *  the loop for audit either way. When no log can be opened the child
 *  inherits our streams (stdout → stderr under --json, so the event
 *  stream stays parseable) — a record-less spawn still works. */

function workerLogPath(ctx: LoopCtx, agentId: string): string {
  const reg = agentRegistryPath(ctx.root);
  if (reg === null || basename(agentId) !== agentId) {
    return '';
  }
  return join(dirname(reg), 'agents', `${agentId}.log`);
}

/** The classified death recorded on a bead's own registry entry — the
 *  cause/resetAt fallback when the status() AgentInfo projection came
 *  back thin (or the connector never projected them). One local JSON
 *  read on a terminal settle; a corrupt registry answers undefined,
 *  never sinks the verdict. */

function entryReset(
  ctx: LoopCtx,
  beadId: string
): { cause?: string; resetAt?: string } | undefined {
  try {
    const e = readAgentRegistry(ctx.root)[beadId];
    if (e === undefined) {
      return undefined;
    }
    return {
      cause: isAgentCause(e.cause) ? e.cause : undefined,
      resetAt: typeof e.resetAt === 'string' && e.resetAt !== '' ? e.resetAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The pending worker's settled exit — the .exit record a detached
 *  `sh -c` leaves in `<git-common>/bro/agents/`. The file's mtime is the
 *  honest wall-clock for the crash window: a poll that lands an
 *  interval late must not inflate an instant crash past crashExitMs.
 *  A worker dead without a record (SIGKILL, spawn failure) falls back
 *  to the log's last write, then now. */

function workerExit(ctx: LoopCtx, w: WorkerRef): { code: number | null; at: number } {
  const log = workerLogPath(ctx, w.agentId);
  if (log !== '') {
    const home = dirname(log);
    try {
      const f = join(home, agentExitFileName(w.agentId, w.runId));
      const n = Number(readFileSync(f, 'utf8').trim());
      return { code: Number.isInteger(n) ? n : null, at: statSync(f).mtimeMs };
    } catch {
      // no exit record — the log clock is the next-best death stamp
    }
    try {
      return { code: null, at: statSync(log).mtimeMs };
    } catch {
      // no log either — detection time is all that remains
    }
  }
  return { code: null, at: ctx.deps.now() };
}

/** The provider wall a 'cap' refusal may name — the derived-registry
 *  read (spec bro-1x7p) consulted only AFTER a refusal proved something
 *  blocked the spawn, so the happy path never pays for it. A template
 *  lane carries no provider identity a wall can be attributed to, and
 *  a broken wall read must not sink a settle — both answer undefined
 *  and fall back to generic pressure handling. */

function laneWall(ctx: LoopCtx, provider: string | undefined): ProviderWall | undefined {
  if (provider === undefined) {
    return undefined;
  }
  try {
    return ctx.deps.providerWall(provider);
  } catch {
    return undefined;
  }
}

/** A refused registry spawn settles the push without a worker. A full
 *  fleet ('cap') holds the claim for the next tick — fleet pressure is
 *  transient, and a hot re-pick would burn the interval against the
 *  same wall. When the 'cap' IS a provider wall (batchWallRefusal) the
 *  wall's own clock rules (bro-36bhc, the convoy-run blockedDecision
 *  contract): `rate_limited` with a provider reset holds pushes UNTIL
 *  the reset — no claim churn per interval — while a `quota` or
 *  no-reset wall parks loud instead of churning claims against a wall
 *  with no advertised end. 'unavailable' is infra — the backend itself
 *  is down, so the pick holds and retries instead of parking (spec
 *  bro-cu3q8). A 'conflict' (live agent, foreign claim,
 *  respawn block) parks WITHOUT a note — the bead's owner is not this
 *  run. Anything else parks with the error named: the claim releases
 *  into the snooze rather than an instant re-queue into the same
 *  refusal. Member claims release either way; on a conflict the LEAD's
 *  claim plane is contested, so only the clump members this run
 *  claimed are reopened. */

function settleSpawnRefusal(ctx: LoopCtx, m: LoopMember, err: unknown): PushOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  // every refusal path releases this run's claims — the claim-time
  // custody record dies with them (bro-ho09d)
  ctx.deps.endRun(loopSlug(m.beads[0]!.id));
  if (err instanceof SpawnError && err.kind === 'cap') {
    const wall = laneWall(ctx, m.lane.provider);
    if (wall !== undefined) {
      // a hold needs the provider's own reset — a `bound` until is our
      // derived cooldown horizon (bro-uswqn), not an advertised end:
      // waiting it out would park nothing and hold pushes for the
      // whole cooldown (the e2e-shaped 60s hang on #728)
      const untilMs =
        wall.until === undefined || wall.bound === true ? Number.NaN : Date.parse(wall.until);
      if (Number.isFinite(untilMs) && untilMs > ctx.deps.now()) {
        // clamp to the 10-year cap so a far-future reset never holds
        // pushes indefinitely (bro-36bhc review)
        const wakeCapMs = ctx.deps.now() + 10 * 365 * 24 * 60 * 60_000;
        const capped = Math.min(untilMs, wakeCapMs);
        // the batch lane waits the reset out — the claims release so
        // the pick re-takes them when the wall lifts (or re-refuses
        // into the same hold if a fresh death re-forms it)
        for (const b of openBeads(ctx, m.beads)) {
          reopenBead(ctx, b.id);
        }
        ctx.deps.say(`loop: ${wallText(wall)} — pushes hold until the reset`);
        return { kind: 'hold', why: msg, untilMs: capped };
      }
      // a wall with no advertised end is reported, not waited into —
      // park once, never churn (the convoy 'parked' verdict)
      parkBeads(
        ctx,
        m.beads,
        `loop: ${wallText(wall)} — no advertised end; worktree ${m.item.worktreeDir}`
      );
      ctx.deps.say(`loop: ${m.beads[0]!.id} parked — ${wallText(wall)}`);
      return { kind: 'done', result: 'parked' };
    }
    for (const b of openBeads(ctx, m.beads)) {
      reopenBead(ctx, b.id);
    }
    ctx.deps.say(`loop: fleet full — ${msg}; pushes hold for the next pass`);
    return { kind: 'hold', why: msg };
  }
  if (err instanceof SpawnError && err.kind === 'unavailable') {
    return settleUnavailableSpawn(ctx, m, msg);
  }
  if (err instanceof SpawnError && err.kind === 'conflict') {
    for (const b of openBeads(ctx, m.beads.slice(1))) {
      reopenBead(ctx, b.id);
    }
  } else {
    parkBeads(ctx, m.beads, `loop: agent spawn refused — ${msg} — worktree ${m.item.worktreeDir}`);
  }
  ctx.deps.say(`loop: ${m.beads[0]!.id} spawn refused — ${msg}`);
  return { kind: 'done', result: 'parked' };
}

/** The 'unavailable' settle (bro-cu3q8): a wedged task store under the
 *  spawn lock, a dead multiplexer, a claim bd killed mid-write — the
 *  store outage class, never a refusal. The registry pin can also
 *  predate the failure (it lands before claimStep): a pid-less entry
 *  reads as a remote worker in flight and walls the retry's re-pick —
 *  mark this push's own entry dead. A refusal thrown before the pin
 *  leaves none to kill.
 *
 *  Ownership: a surviving row is a dead pin ONLY while it still
 *  carries a launch-failure stamp — commitSpawn clears spawnError/pid
 *  on every fresh row and a live worker's handle lands the pid, so a
 *  pid-less entry with a non-empty spawnError can only be a spawn that
 *  stamped its own row and died before launch. A racing respawn's
 *  fresh row has neither and must never be stopped. The predicate and
 *  the write ride ONE registry lock — a separate read-then-patch could
 *  stop a live worker that slipped between the two.
 *
 *  The lead's claim can survive a post-commit backend failure too (the
 *  connector's CAS rollback only covers commitSpawn's own writes):
 *  claimStep succeeded, then tmux/launch died, and the lead sits
 *  in_progress with no worker — ready skips it, the infra hold can't
 *  re-pick it. Reopen it ONLY while the claim still names an owner
 *  this spawn wrote: the attempt's actor (bdActor) or the claimAs
 *  identity (the step id itself). An assignee a foreign loop moved
 *  meanwhile is theirs — reopening would steal a live claim. Batch
 *  members were claimMembers'd by this push and release
 *  unconditionally below. */

function settleUnavailableSpawn(ctx: LoopCtx, m: LoopMember, msg: string): PushOutcome {
  patchAgentRegistryIf(
    ctx.root,
    m.beads[0]!.id,
    { stopped: true, spawnError: msg },
    cur =>
      cur !== undefined &&
      cur.stopped !== true &&
      cur.pid === undefined &&
      typeof cur.spawnError === 'string' &&
      cur.spawnError !== ''
  );
  const leadClaim =
    ctx.beadsDir !== undefined ? probeStep(ctx.beadsDir, m.beads[0]!.id) : undefined;
  if (
    leadClaim?.status === 'in_progress' &&
    leadClaim.assignee !== undefined &&
    leadClaim.assignee !== '' &&
    (leadClaim.assignee === bdActor(ctx.beadsDir!) || leadClaim.assignee === m.beads[0]!.id)
  ) {
    reopenBead(ctx, m.beads[0]!.id);
  }
  // batch members claimed by claimMembers remain in_progress even if
  // the lead spawn never landed; release them now so the retry can
  // re-pick (the lead's claim is uncertain and the infra hold owns
  // custody until recovered). The store may be wedged, but a failed
  // reopen is best-effort — tryClaim still un-sees and holds an interval.
  for (const b of openBeads(ctx, m.beads.slice(1))) {
    reopenBead(ctx, b.id);
  }
  return { kind: 'infra', why: msg };
}

/** PR number opened from this worktree's branch — null when none,
 *  'lookup-error' when gh itself failed (not the same thing: a failed
 *  lookup must not reopen a bead whose PR may still exist). */

function findPr(ctx: LoopCtx, branch: string): number | null | 'lookup-error' {
  try {
    return ctx.deps.rev.prsForBranch(branch)[0] ?? null;
  } catch {
    return 'lookup-error';
  }
}

function stampProjection(ctx: LoopCtx, beads: ReadyBead[], pr: number): void {
  const refs = projectBeads(
    {
      tasks: ctx.deps.tasks,
      mirror: ctx.deps.mirror,
      hasSpec: ctx.deps.specHas,
      policy: ctx.mirrorPolicy,
      say: m => ctx.deps.say(`loop: ${m}`),
    },
    beads.map(b => b.id)
  );
  if (refs.length === 0 || ctx.deps.rev.linkCloses === undefined) {
    return;
  }
  try {
    ctx.deps.rev.linkCloses({ repo: ctx.repo, pr }, refs);
    ctx.deps.say(
      `loop: ${prRef(ctx, pr)} wired Fixes ${refs
        .map(r => (/^\d+$/.test(r) ? issueLink(ctx.repo, Number(r)) : r))
        .join(', ')}`
    );
  } catch (err) {
    ctx.deps.error(`loop: ${prRef(ctx, pr)} Fixes wiring failed — ${String(err)}`);
  }
}

/** PR ownership marking (spec bro-c650l) — stamped at DISCOVERY, the
 *  one chokepoint every loop PR crosses, never trusted to the worker's
 *  pr-create flags. A draft is the merge=human contract — bro opened
 *  it, the human merges — so it stamps 'bro-review'; everything else
 *  is 'bro-managed'. Best-effort by contract: a host without labels
 *  skips the label half, a failed write warns, and the gate stack arms
 *  either way. */

function stampLoopPr(ctx: LoopCtx, beads: ReadyBead[], item: LoopItem, pr: number): void {
  let draft = false;
  try {
    draft = ctx.deps.rev.prMeta({ repo: ctx.repo, pr }).isDraft;
  } catch {
    // a failed probe stamps managed — the loop's honest claim for the
    // PR it just pushed (the gate still blocks a draft below)
  }
  stampPrOwnership(
    ctx.deps.rev,
    { repo: ctx.repo, pr },
    {
      ownership: draft ? 'review' : 'managed',
      meta: {
        managed: !draft,
        bead: beads.map(b => b.id).join(','),
        mode: 'loop',
        run: item.branch,
      },
    },
    msg => ctx.deps.error(`loop: ${msg}`)
  );
}

/** Best-effort return of a bead to the open queue — the claim's
 *  release transition lands in the lifecycle journal beside it. */

function clumpCommitLog(ctx: LoopCtx, item: LoopItem, pr: number): string {
  let base = ctx.deps.defaultBranch() ?? 'main';
  let headSha = '';
  try {
    const meta = ctx.deps.rev.prMeta({ repo: ctx.repo, pr });
    base = meta.baseRef || base;
    headSha = meta.headSha;
  } catch {
    /* fall back to the default branch guess + local tip */
  }
  return gitBranchLog(headSha, base, item.worktreeDir);
}

/** The landed close — a `close` row in the lifecycle journal beside
 *  the store transition. */

function closeLanded(ctx: LoopCtx, id: string, pr: number, link: string): void {
  try {
    ctx.deps.tasks.close(id, `landed via PR ${link}`);
    emitLifecycle(ctx.root, {
      kind: 'close',
      bead: id,
      pr,
      from: 'in_progress',
      to: 'closed',
      detail: { via: 'loop' },
    });
  } catch (err) {
    ctx.deps.error(`loop: ${ctx.backend} close ${id} failed — ${String(err)}`);
  }
}

/** Settle the clump after its PR merged — every still-open member named
 *  in the branch's commits closes 'landed'; the rest reopen into the
 *  queue (the unfinished tail re-queues, never silently closes). A solo
 *  item keeps the unconditional close — its prompt never owed a naming
 *  contract. */

function settleClump(ctx: LoopCtx, beads: ReadyBead[], item: LoopItem, pr: number): void {
  const link = prRef(ctx, pr);
  const statuses = beadStatuses(ctx, beads);
  if (beads.length === 1) {
    // the agent may have closed it already — a verdict plus a PR both
    // reaching the store is fine; a second close is a noisy error
    if (statuses.get(beads[0]!.id) !== 'closed') {
      closeLanded(ctx, beads[0]!.id, pr, link);
    }
    return;
  }
  const covered = coveredBeadIds(
    clumpCommitLog(ctx, item, pr),
    beads.map(b => b.id)
  );
  for (const b of beads) {
    if (statuses.get(b.id) === 'closed') {
      continue; // the agent's own verdict stands
    }
    if (covered.has(b.id)) {
      closeLanded(ctx, b.id, pr, link);
    } else {
      // merged without a commit naming it — unfinished tail re-queues
      noteBead(ctx, b.id, `loop: ${link} landed without a commit naming ${b.id} — re-queued`);
      reopenBead(ctx, b.id);
      ctx.deps.say(`loop: ${b.id} not covered by ${link} — re-queued`);
    }
  }
}

/** Merge the PR, close the bead(s), drop the worktree. 'landed' only
 *  when the PR reports MERGED — a closed or still-open PR parks the
 *  bead. `alreadyMerged` skips the merge call for PRs that landed
 *  externally while the gate was polling. */

async function finalizeMerge(
  ctx: LoopCtx,
  beads: ReadyBead[],
  item: LoopItem,
  pr: number,
  alreadyMerged = false
): Promise<'landed' | 'parked'> {
  ctx.stage = `merge pr=${pr}`;
  try {
    if (!alreadyMerged) {
      await ctx.deps.mergePr(pr);
    }
    const meta = ctx.deps.rev.prMeta({ repo: ctx.repo, pr });
    if (meta.state !== 'MERGED') {
      // a CLOSED PR settled without merging — its sessions are done; an
      // OPEN park keeps the session alive for the next round
      if (meta.state === 'CLOSED') {
        try {
          ctx.deps.settleSessions(item.worktreeDir);
        } catch {
          // advisory
        }
      }
      parkBeads(
        ctx,
        beads,
        `loop: merge of ${prRef(ctx, pr)} did not land (state=${meta.state}) — worktree ${item.worktreeDir}`
      );
      return 'parked';
    }
    if (alreadyMerged) {
      // a bro-driven merge journals through act's landPr — an external
      // landing skips the call, so this arm carries its own row
      emitLifecycle(ctx.root, {
        kind: 'merge',
        bead: beads[0]!.id,
        pr,
        to: 'merged',
        detail: { via: 'loop', external: true, sha: meta.headSha },
      });
    }
  } catch (err) {
    // a merge/fetch failure must not abort the loop leaving the bead
    // claimed forever — note it and park
    parkBeads(
      ctx,
      beads,
      `loop: finalizing ${prRef(ctx, pr)} failed — ${err instanceof Error ? err.message : String(err)} — worktree ${item.worktreeDir}`
    );
    return 'parked';
  }
  try {
    ctx.deps.settleSessions(item.worktreeDir);
  } catch {
    // advisory
  }
  settleClump(ctx, beads, item, pr);
  // a process rooted in the tree (a serve, a watcher, a leftover agent)
  // keeps it — removal would strand a zombie on deleted files (bro-1usa8)
  const rooted = processesRootedIn(item.worktreeDir);
  if (rooted.length > 0) {
    ctx.tails.push(
      `worktree ${item.worktreeDir} kept — hosts live process(es): ${rooted.map(h => h.pid).join(', ')}; branch ${item.branch} kept with it`
    );
    ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
  }
  if (rooted.length === 0) {
    // an agent-initialized submodule inside the worktree blocks removal —
    // deinit first; either way a failed cleanup is loud, never silent
    gitTry(['-C', item.worktreeDir, 'submodule', 'deinit', '-f', '--all']);
    const rm = gitTry(['-C', ctx.root, 'worktree', 'remove', '--force', item.worktreeDir]);
    if (rm.code !== 0) {
      ctx.tails.push(`worktree ${item.worktreeDir} not removed — ${rm.err.trim()}`);
      ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
    }
    // Remove any worktree checked out on this branch first (including possibly another one)
    try {
      const trees = ctx.deps.worktrees();
      if (trees !== null) {
        for (const t of trees) {
          if (t.branch === item.branch && t.path) {
            if (t.path === item.worktreeDir) {
              continue;
            }
            const r = processesRootedIn(t.path);
            // same contract as the primary removal: a live process or
            // uncommitted work keeps the checkout — --force would burn
            // files nothing else holds (and strand the process on them)
            const st =
              r.length === 0
                ? gitTry(['-C', t.path, 'status', '--porcelain'])
                : { code: 1, out: '', err: '' };
            if (r.length === 0 && st.code === 0 && st.out.trim() === '') {
              gitTry(['-C', t.path, 'submodule', 'deinit', '-f', '--all']);
              gitTry(['-C', ctx.root, 'worktree', 'remove', '--force', t.path]);
            } else if (r.length === 0) {
              ctx.tails.push(
                `worktree ${t.path} kept — has uncommitted changes or status unreadable; branch ${item.branch} kept with it`
              );
            } else {
              ctx.tails.push(
                `worktree ${t.path} kept — hosts live process(es): ${r.map(h => h.pid).join(', ')}; branch ${item.branch} kept with it`
              );
            }
          }
        }
      }
    } catch {
      /* best effort */
    }
    // Only delete branch if no worktree is still using it
    try {
      const trees2 = ctx.deps.worktrees();
      if (trees2 !== null) {
        const stillCheckedOut = trees2.some(t => t.branch === item.branch);
        if (!stillCheckedOut) {
          const br = gitTry(['-C', ctx.root, 'branch', '-D', item.branch]);
          if (br.code !== 0) {
            ctx.tails.push(`branch ${item.branch} not deleted — ${br.err.trim()}`);
            ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
          }
        } else {
          ctx.tails.push(`branch ${item.branch} not deleted — checked out in a worktree`);
          ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
        }
      } else {
        const br = gitTry(['-C', ctx.root, 'branch', '-D', item.branch]);
        if (br.code !== 0) {
          ctx.tails.push(`branch ${item.branch} not deleted — ${br.err.trim()}`);
          ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
        }
      }
    } catch {
      const br = gitTry(['-C', ctx.root, 'branch', '-D', item.branch]);
      if (br.code !== 0) {
        ctx.tails.push(`branch ${item.branch} not deleted — ${br.err.trim()}`);
        ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
      }
    }
    // delete remote branch on merge/close (spec bro-jis0c)
    deleteRemoteBranch(ctx, item.branch, '');
  } else {
    // even if worktree kept due to live processes, try to delete remote branch if possible
    deleteRemoteBranch(ctx, item.branch, '');
  }
  ctx.deps.say(`loop: ${beads.map(b => b.id).join(', ')} landed via ${prRef(ctx, pr)}`);
  return 'landed';
}

/** The command a raw-template spawn actually runs — the lane worker's
 *  own payload when it carries one, else the resolved lane command. */

function deleteRemoteBranch(ctx: LoopCtx, branch: string, why: string): void {
  const del = gitTry(['-C', ctx.root, 'push', 'origin', '--delete', branch]);
  if (del.code === 0 || /remote ref does not exist|Couldn't find remote ref/i.test(del.err)) {
    return;
  }
  ctx.tails.push(
    `remote branch ${branch} not deleted${why === '' ? '' : ` ${why}`} — ${del.err.trim()}`
  );
  ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
}

/** The member ids a `loop/` PR's provenance trailer stamps — `bead:
 *  "id1,id2"` written by stampLoopPr when the clump pushed. null when
 *  the list can't be proven: no prBody capability on the host, a fetch
 *  error, or a batch head with no trailer. An unenumerated batch is
 *  never a burial order. */

async function runFixRound(
  ctx: LoopCtx,
  m: LoopMember,
  pr: number,
  round: number,
  lane: LoopLane
): Promise<void> {
  ctx.stage = `fix round ${round} pr=${pr}`;
  const threads = (await ctx.deps.rev.reviewThreads({ repo: ctx.repo, pr }))
    .filter(t => !t.resolved)
    .map(t => {
      const c = t.comment;
      return `- ${c?.path ?? ''}:${c?.line ?? ''} [${c?.author ?? '?'}] ${c?.body ?? ''}`;
    })
    .join('\n');
  // Threads may have been resolved between the gate snapshot and this
  // fetch — respawning the agent on an empty fix list wastes a round.
  if (threads === '') {
    ctx.deps.say(
      `loop: ${prRef(ctx, pr)} threads resolved since the gate snapshot — skipping fix round`
    );
    // no spawn ran — refund the round the same way a fleet-cap refusal
    // does; the budget bills respawns, not stale gate snapshots
    m.rounds -= 1;
    return;
  }
  const prompt = buildFixPrompt(m.beads, pr, threads);
  writePrompt(m.item, prompt);
  ctx.deps.say(`loop: ${prRef(ctx, pr)} has open threads — fix round ${round}`);
  if (ctx.deps.agents !== undefined) {
    await ctx.deps.spawnWorker(m, prompt);
    return;
  }
  const leadFix = m.beads[0]!;
  const fixKey = `loop-fix-${leadFix.id}`;
  let templateReservation: string | undefined;
  let crossKindReservations: string[] = [];
  try {
    const admission = ctx.deps.admitTemplate(
      lane,
      { molStep: leadFix.id, prompt, repoRoot: m.item.worktreeDir },
      fixKey
    );
    templateReservation = admission.reservation;
    crossKindReservations = admission.crossKind;
  } catch (err) {
    ctx.deps.error(
      `loop: fix round session quota admission failed — ${err instanceof Error ? err.message : String(err)}`
    );
    // admission threw before returning — every claim it held was
    // already handed back inside admitLaneSessions
    // Let respawnRound handle cap (decrements rounds) and other failures
    throw err;
  }
  let code: number | null = null;
  try {
    code = await ctx.deps.spawnTemplate(
      lane,
      m.beads.map(b => b.id),
      clumpTitle(m.beads),
      m.item.promptFile,
      m.item.worktreeDir,
      fixKey
    );
  } finally {
    if (templateReservation !== undefined) {
      releaseSessionSlot(templateReservation);
    }
    releaseSessionStart(crossKindReservations);
  }
  if (code !== 0) {
    ctx.deps.error(`loop: fix agent exited ${code ?? 'abnormal'} — the next gate poll decides`);
  }
}

/** The spawned worker's env title — a clump names the lead plus its
 *  tail size so provenance still reads as one line. */

async function runRebaseRound(
  ctx: LoopCtx,
  m: LoopMember,
  pr: number,
  round: number,
  lane: LoopLane
): Promise<void> {
  let base: string;
  try {
    base = ctx.deps.rev.prMeta({ repo: ctx.repo, pr }).baseRef;
  } catch (err) {
    ctx.deps.error(
      `loop ${prRef(ctx, pr)}: base lookup for the rebase round failed — ${String(err)}`
    );
    return;
  }
  const prompt = buildRebasePrompt(m.beads, pr, base);
  writePrompt(m.item, prompt);
  ctx.deps.say(`loop: ${prRef(ctx, pr)} conflicts — rebase round ${round} onto ${base}`);
  if (ctx.deps.agents !== undefined) {
    await ctx.deps.spawnWorker(m, prompt);
    return;
  }
  const leadRb = m.beads[0]!;
  const rebaseKey = `loop-rebase-${leadRb.id}`;
  let templateReservation: string | undefined;
  let crossKindReservationsRb: string[] = [];
  try {
    const admission = ctx.deps.admitTemplate(
      lane,
      { molStep: leadRb.id, prompt, repoRoot: m.item.worktreeDir },
      rebaseKey
    );
    templateReservation = admission.reservation;
    crossKindReservationsRb = admission.crossKind;
  } catch (err) {
    // admission threw before returning — every claim it held was
    // already handed back inside admitLaneSessions
    ctx.deps.error(
      `loop: rebase round session quota admission failed — ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
  let code: number | null = null;
  try {
    code = await ctx.deps.spawnTemplate(
      lane,
      m.beads.map(b => b.id),
      clumpTitle(m.beads),
      m.item.promptFile,
      m.item.worktreeDir,
      rebaseKey
    );
  } finally {
    if (templateReservation !== undefined) {
      releaseSessionSlot(templateReservation);
    }
    releaseSessionStart(crossKindReservationsRb);
  }
  if (code !== 0) {
    ctx.deps.error(`loop: rebase agent exited ${code ?? 'abnormal'} — the next gate poll decides`);
  }
}

/** `--label a,b` → selection filters — flag() covers both spellings; a
 *  declared-but-empty value fails closed (silently widening to the
 *  whole queue is exactly what --label prevents). */

async function respawnRound(
  ctx: LoopCtx,
  m: LoopMember,
  run: () => Promise<void>
): Promise<'kept' | 'active'> {
  m.rounds += 1;
  try {
    await run();
  } catch (err) {
    // a fleet-cap refusal is transient pressure, not a repair attempt —
    // repeated refusals must not burn fixRounds into a park
    if (err instanceof SpawnError && err.kind === 'cap') {
      m.rounds -= 1;
    } else if (
      err instanceof SpawnError &&
      (err.kind === 'unavailable' || err.kind === 'config' || err.kind === 'input')
    ) {
      m.rounds -= 1;
    }
    ctx.deps.error(`loop ${prRef(ctx, m.pr!)}: respawn round ${m.rounds} failed — ${String(err)}`);
    return 'kept';
  }
  if (m.worker !== undefined) {
    // the respawn joined the worker lifecycle — its .exit landing IS
    // the gate re-entry now, not this return (spec bro-zpa93)
    return 'kept';
  }
  m.since = ctx.deps.now();
  return 'active';
}

/** The conflict round — the member's PR is CONFLICTING; the agent
 *  rebases onto the PR's declared base and pushes. A base that can't
 *  be looked up skips the spawn (the round still consumed the budget —
 *  a blind rebase order would be worse). */

function leave(m: LoopMember, verdict: ItemResult): ItemResult {
  if (verdict === 'parked') {
    emitLifecycle(m.item.worktreeDir, {
      kind: 'park',
      bead: m.beads[0]!.id,
      ...(m.pr !== undefined ? { pr: m.pr } : {}),
      to: 'parked',
      detail: {
        via: 'loop',
        ...(m.beads.length > 1 ? { beads: m.beads.map(b => b.id).join(',') } : {}),
      },
    });
  }
  watchEnd(m.marker);
  return verdict;
}

/** One respawn round (fix or rebase): consumes budget, resets the
 *  member clock on success, and degrades to a quiet keep when the round
 *  itself fails — a reviewThreads/prMeta fetch dying on ONE member must
 *  not abort the run and orphan every other gate's claim. The clock
 *  only resets on a round that actually ran. */

async function serviceWorker(ctx: LoopCtx, m: LoopMember): Promise<ServiceVerdict> {
  const w = m.worker!;
  ctx.stage = `worker ${w.agentId} pid=${w.pid ?? '?'}`;
  ctx.bead = m.beads[0]!.id;
  let info: AgentInfo | undefined;
  try {
    info = await ctx.deps.agents!.status(w.agentId);
  } catch (err) {
    if (!(err instanceof AgentNotFound)) {
      m.fetchErrors += 1;
      ctx.deps.error(`loop: worker ${w.agentId} status failed (${m.fetchErrors}) — ${String(err)}`);
      if (m.fetchErrors < 3) {
        return 'kept';
      }
      return loopPolicy.onPark(
        ctx,
        m,
        `loop: worker status kept failing for ${w.agentId} — ${String(err)} — worktree ${m.item.worktreeDir}`
      );
    }
    // a reaped entry can't prove its death — 'lost' settles it below
  }
  // a successful status read clears the strike count — isolated fetch
  // errors between healthy polls must not accumulate toward the park
  m.fetchErrors = 0;
  const superseded =
    info?.spawnedAt !== undefined && w.spawnedAt !== undefined && info.spawnedAt !== w.spawnedAt;
  const state: AgentState = superseded || info === undefined ? 'lost' : info.state;
  if (state === 'running' || state === 'spawned') {
    return 'kept';
  }
  // a superseded entry's .exit belongs to the NEW generation — its
  // code/mtime would feed a foreign clock into the crash window
  const exit = superseded ? { code: null, at: ctx.deps.now() } : workerExit(ctx, w);
  ctx.deps.say(
    `loop: worker ${w.agentId} ${exit.code === null ? `${state} — no exit record` : `exited ${exit.code}`}`
  );
  m.worker = undefined;
  // the worker is gone — the settle is the policy's onLost verb:
  // the terminal poll's facts ride the member so the verb sees the same
  // snapshot the poll produced (info/exit/state/superseded/ids).
  m.lost = { agentId: w.agentId, spawnedMs: w.spawnedMs, info, exit, state, superseded };
  return loopPolicy.onLost(ctx, m);
}

/** The worker-'lost' settle — Policy.onLost. Everything the terminal
 *  poll decided is on `m.lost`; the member either re-enters its own gate
 *  (a fix/rebase round's exit IS the re-poll), waits out a provider
 *  wall, parks, or discovers the PR the worker opened and joins the
 *  gate stack. Moved verbatim from serviceWorker's post-poll tail. */

function serviceLost(ctx: LoopCtx, m: LoopMember): ServiceVerdict {
  const { agentId, spawnedMs, info, exit, state, superseded } = m.lost!;
  if (m.pr !== undefined) {
    // a fix/rebase worker's exit IS the gate re-entry — same contract
    // the awaited spawn's return had. The worker may have moved the
    // PR (pushes, resolves, replies), so the feed entry that spawned
    // its round is obsolete — the re-poll must fetch post-worker
    // truth, not re-serve the ≤ttl-old snapshot and burn rounds
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr: m.pr });
    m.since = ctx.deps.now();
    // custody stays with the armed watch marker — the worker's run
    // record retires with the round (bro-wg896)
    ctx.deps.endRun(loopSlug(m.beads[0]!.id));
    // fix/rebase wall check (bro-36bhc): a rate_limited death with a
    // reset defers the re-poll to the reset (round refunded — a wall
    // death is not a repair attempt); quota/auth/reset-less parks.
    const entry = entryReset(ctx, m.beads[0]!.id);
    const cause = info?.cause ?? entry?.cause;
    const resetAt = cause === 'rate_limited' ? (info?.resetAt ?? entry?.resetAt) : undefined;
    const verdict = agentVerdict(ctx, m.beads, m.item.worktreeDir);
    if (verdict !== undefined) {
      return leave(m, verdict);
    }
    // a stopped entry's stale wall stamp is not a horizon either —
    // same exclusion the no-PR wait below takes (bro-36bhc)
    const wait =
      state !== 'stopped'
        ? wallWaitUntil(cause, resetAt, ctx.deps.now(), m.wallWaits ?? 0)
        : undefined;
    if (wait !== undefined) {
      m.wallWaitUntil = wait;
      m.wallWaits = (m.wallWaits ?? 0) + 1;
      // the merge clock restarts at the wall's lift — time spent
      // walled is not time the re-poll owed the merge deadline
      m.since = wait;
      // refund the round the dead worker paid
      m.rounds = Math.max(0, m.rounds - 1);
      return 'kept';
    }
    if (cause === 'quota' || cause === 'auth' || cause === 'rate_limited') {
      return loopPolicy.onPark(
        ctx,
        m,
        `loop: ${prRef(ctx, m.pr)} round worker ${agentId} hit a provider wall (${cause}) — worktree ${m.item.worktreeDir}`
      );
    }
    if (exit.code === 0 && !superseded) {
      // If the fix worker exited cleanly but did not resolve threads,
      // we must not let the cycle loop forever. Do not auto-retry here;
      // let the gate re-poll and the memberAction decide. However, ensure
      // we don't re-trigger without budget pressure - the gate will see
      // current thread state. Also log to make the behavior explicit.
      ctx.deps.error(
        `loop ${prRef(ctx, m.pr)}: fix worker exited 0 without obvious thread resolution — gate will re-poll`
      );
    }
    return 'active';
  }
  // custody returns to the supervisor for the findPr/arm window —
  // re-stamp the run record with this process's pid so the just-dead
  // worker's id never reads as a crashed run between here and the
  // verdict (the awaited spawn's settle stamps the same, bro-ho09d).
  // The log stays the worker's agents-plane log — the connector's own
  // recorded path first, the conventional <id>.log when the entry is
  // already gone
  ctx.deps.beginRun({
    beadId: m.beads[0]!.id,
    beadIds: m.beads.map(b => b.id),
    slug: loopSlug(m.beads[0]!.id),
    pid: process.pid,
    pidStart: procStat(process.pid)?.start,
    startedAt: new Date(ctx.deps.now()).toISOString(),
    worktree: m.item.worktreeDir,
    log: info?.log ?? workerLogPath(ctx, agentId),
  });
  ctx.stage = 'pr lookup';
  const pr = findPr(ctx, m.item.branch);
  if (pr === 'lookup-error') {
    return loopPolicy.onPark(
      ctx,
      m,
      `loop: PR lookup failed for ${m.item.branch} — worktree ${m.item.worktreeDir}`
    );
  }
  if (pr === null) {
    const entry = entryReset(ctx, m.beads[0]!.id);
    const cause = info?.cause ?? entry?.cause;
    const resetAt = cause === 'rate_limited' ? (info?.resetAt ?? entry?.resetAt) : undefined;
    // the agent's own verdict still outranks the wall (bro-36bhc)
    const verdict = agentVerdict(ctx, m.beads, m.item.worktreeDir);
    if (verdict !== undefined) {
      return leave(m, verdict);
    }
    // a rate_limited death carrying a NEAR reset waits (auto-respawn)
    // instead of parking; a far reset parks (deferred) so the run does
    // not hold for hours — the operator wakes it when the wall lifts.
    // A STOPPED entry is out entirely: `bro agents down` keeps the old
    // death's cause/resetAt on the record, so its stale wall stamp is
    // not a horizon to wait — the parkIt branch owns the flat cooldown.
    const resetMs =
      resetAt !== undefined && Number.isFinite(Date.parse(resetAt))
        ? Date.parse(resetAt)
        : undefined;
    const near =
      state !== 'stopped' &&
      resetMs !== undefined &&
      (resetMs <= ctx.deps.now() || resetMs - ctx.deps.now() <= 15 * 60 * 1000);
    const wait = near ? wallWaitUntil(cause, resetAt, ctx.deps.now(), m.wallWaits ?? 0) : undefined;
    if (wait !== undefined) {
      m.wallWaitUntil = wait;
      m.wallWaits = (m.wallWaits ?? 0) + 1;
      // walled time is not member time — the since-clock restarts at
      // the lift, same exclusion the PR path takes
      m.since = wait;
      ctx.deps.say(
        `loop: worker ${agentId} rate_limited${resetAt !== undefined ? ` til ${resetAt}` : ''} without a PR — waiting`
      );
      return 'kept';
    }
    // exited deaths can still carry a wall cause (rate_limited whose
    // resetAt already passed at poll time reads 'exited', not 'blocked');
    // park those instead of reopening into the same wall (bro-36bhc).
    const parkIt =
      state === 'blocked' ||
      state === 'stopped' ||
      (state === 'exited' && (cause === 'rate_limited' || cause === 'quota' || cause === 'auth'));
    if (parkIt) {
      // reset-aware: only a future reset snoozes to it; a stale/missing
      // reset takes the flat cooldown so we never wake straight back
      // into the wall.
      const rawReset = cause === 'rate_limited' && state !== 'stopped' ? resetAt : undefined;
      const resetMs =
        rawReset !== undefined &&
        Number.isFinite(Date.parse(rawReset)) &&
        Date.parse(rawReset) > ctx.deps.now()
          ? Date.parse(rawReset)
          : undefined;
      const why =
        state === 'blocked'
          ? `blocked${cause !== undefined ? ` (${cause})` : ''}${resetMs !== undefined && rawReset !== undefined ? ` til ${rawReset}` : ''}`
          : state === 'exited'
            ? `exited${cause !== undefined ? ` (${cause})` : ''}${resetMs !== undefined && rawReset !== undefined ? ` til ${rawReset}` : ''}`
            : 'stopped';
      return loopPolicy.onPark(
        ctx,
        m,
        `loop: worker ${agentId} ${why} without a PR — worktree ${m.item.worktreeDir}`,
        resetMs
      );
    }
    return leave(m, settleNoPr(ctx, m.beads, m.item, exit.code, Math.max(0, exit.at - spawnedMs)));
  }
  // the worker opened a PR — the member joins its own gate: the loop IS
  // the watcher (bro-z0k2u), the marker arms for the member's whole
  // stack tenure so a dead loop leaves a resurface `act rearm` can
  // resurrect (bro-q6ppv), and `bead` rides comma-joined for the
  // finalizeMerge half the dead loop never reached
  m.pr = pr;
  emitLifecycle(ctx.root, {
    kind: 'pr-open',
    bead: m.beads[0]?.id,
    pr,
    to: 'open',
    detail: {
      via: 'loop',
      branch: m.item.branch,
      ...(agentId !== undefined ? { agent: agentId } : {}),
    },
  });
  // marker before the stamp — stampProjection's tracker calls can
  // stall or die, and a markerless open PR resurrects nothing
  m.marker = watchBegin(ctx.root, {
    ...loopWatch(pr, prRef(ctx, pr), m.item.worktreeDir, ctx.cfg),
    bead: m.beads.map(b => b.id).join(','),
  });
  // custody transfers to the armed watch — the run record's job is
  // done (the same handoff the awaited path runs at pushItem)
  ctx.deps.endRun(loopSlug(m.beads[0]!.id));
  stampProjection(ctx, m.beads, pr);
  // ownership marking (spec bro-c650l) — the registry-spawn path's
  // discovery is HERE, not pushItem: a detached worker's PR only
  // exists once this settle pass finds it
  stampLoopPr(ctx, m.beads, m.item, pr);
  m.since = ctx.deps.now();
  ctx.deps.say(`loop: ${m.beads.map(b => b.id).join(', ')} → PR ${prRef(ctx, pr)}`);
  return 'active';
}

/** One member's service tick — the per-member cadence gate. A 'kept'
 *  verdict stamps the stage's own poll interval (a pending worker's
 *  local .exit probe is cheap — WORKER_POLL_MS; a PR gate's fetch is
 *  the shared review host — intervalS), so the stack's wake set stays
 *  honest: worker exits land fast without dragging every gate into
 *  hot host polls, and a long worker never starves the stack. */

async function serviceMember(ctx: LoopCtx, m: LoopMember): Promise<ServiceVerdict> {
  // a member sitting in a provider wall wait (bro-36bhc) — service the
  // wait instead of the gate/worker. PR members re-poll at expiry;
  // workerless members respawn the same work order.
  if (m.wallWaitUntil !== undefined) {
    if (ctx.deps.now() < m.wallWaitUntil) {
      m.nextPollAt = m.wallWaitUntil;
      return 'kept';
    }
    m.wallWaitUntil = undefined;
    if (m.pr !== undefined) {
      return 'active';
    }
    if (m.worker === undefined) {
      try {
        ctx.deps.say('loop: respawn after wall');
        await ctx.deps.spawnWorker(m, m.prompt ?? '');
        return 'kept';
      } catch (err) {
        ctx.deps.say(`loop: respawn failed — ${err instanceof Error ? err.message : String(err)}`);
        const out = settleSpawnRefusal(ctx, m, err);
        if (out.kind === 'hold') {
          m.wallWaitUntil = out.untilMs ?? ctx.deps.now() + ctx.intervalS * 1000;
          m.wallWaits = (m.wallWaits ?? 0) + 1;
          return 'kept';
        }
        if (out.kind === 'done') {
          return out.result;
        }
        if (out.kind === 'infra') {
          // the respawn's own backend wedged — infra, not a wall, so
          // there is no provider reset to wait out. Re-arm the wait
          // one interval and let the respawn retry at expiry;
          // without it the member falls through workerless into the
          // PR gate with no PR (bro-cu3q8)
          m.wallWaitUntil = ctx.deps.now() + ctx.intervalS * 1000;
          return 'kept';
        }
        return 'kept';
      }
    }
  }
  if (m.nextPollAt !== undefined && ctx.deps.now() < m.nextPollAt) {
    return 'kept';
  }
  m.nextPollAt = undefined;
  // finish a marker that died mid-settle: when watchBegin threw inside
  // the worker's PR-discovery settle, m.pr is already armed and
  // m.worker already cleared — a retry would service the gate with a
  // null marker forever, and act rearm could never resurrect the PR.
  // Complete the begin BEFORE the refresh/gate below; a throw here
  // strikes fetchErrors and re-polls, so the marker eventually lands
  // or the member parks on the same budget as any fetch outage.
  if (m.marker === null && m.pr !== undefined) {
    m.marker = watchBegin(ctx.root, {
      ...loopWatch(m.pr, prRef(ctx, m.pr), m.item.worktreeDir, ctx.cfg),
      bead: m.beads.map(b => b.id).join(','),
    });
  }
  // re-stamp the member's marker on every real service tick — stallMin
  // is advisory, so a running member outlives the marker's priced TTL
  // (the 24h floor included) and a pruned marker reads as an orphaned
  // PR to drive. Same file, same 'wait' kind; watchEnd still owns it.
  watchRefresh(m.marker);
  const verdict =
    m.worker !== undefined ? await serviceWorker(ctx, m) : await loopPolicy.onGate(ctx, m);
  // a service dispatch that returned without throwing clears the
  // settle-failure strikes — the skip paths above never reach this
  // line, so backoff passes can't zero a live streak, and the fetch
  // arms' own fetchErrors resets stay untouched (bro-cu3q8)
  m.serviceErrors = 0;
  if (verdict === 'kept') {
    m.nextPollAt =
      ctx.deps.now() +
      // a run that ticks below the worker poll's real-time second
      // services .exit reads on its own cadence — never slower than it
      (m.worker !== undefined
        ? Math.min(WORKER_POLL_MS, ctx.intervalS * 1000)
        : ctx.intervalS * 1000);
  }
  return verdict;
}

/** One member's settled snapshot → the mapped action. 'kept' parks the
 *  member until the next interval tick (a quiet wait); 'active' keeps
 *  it too but asks the scheduler for an immediate re-poll — a fix/
 *  rebase/update just moved the gate, exactly like the old serial
 *  waitForGate re-entry did. 'landed'/'parked' remove it. */

async function serviceGate(ctx: LoopCtx, m: LoopMember): Promise<ServiceVerdict> {
  const pr = m.pr!;
  ctx.stage = `gate pr=${pr}`;
  ctx.bead = m.beads[0]!.id;
  let snap: GateSnapshot;
  try {
    const state = await fetchPrActState(
      ctx.deps.rev,
      { repo: ctx.repo, pr },
      {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.root),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
        requireApproval: ctx.act.requireApproval,
        approvers: ctx.act.approvers,
        stateCache: ctx.deps.stateCache,
        resolveLedger: resolveLedger(ctx.root),
      }
    );
    const gate = evaluateExitGate(state, { requireApproval: ctx.act.requireApproval });
    ctx.deps.error(
      `loop ${prRef(ctx, pr)}: threads=${gate.open_threads} ci=${gate.ci_pending}+${gate.ci_failing}f rev=${gate.reviewers_pending} sast=${gate.sast_pending}`
    );
    snap = {
      state: state.state,
      headSha: state.headSha,
      mergeable: state.mergeable,
      mergeState: state.mergeState,
      openThreads: state.openThreads,
      reopenedThreads: state.reopenedThreads?.length ?? 0,
      fixRounds: state.fixRounds,
      maxRounds: state.maxRounds,
      ok: gate.ok,
      blockers: gate.blockers,
      pending: gatePending(state),
    };
  } catch (err) {
    m.fetchErrors += 1;
    ctx.deps.error(`loop ${prRef(ctx, pr)}: fetch failed (${m.fetchErrors}) — ${String(err)}`);
    // the old wait gave up on 3 consecutive failures OR its deadline —
    // a member whose fetch plane is down past mergeTimeoutMin settles
    // the same way rather than keeping a slot forever
    if (m.fetchErrors < 3 && ctx.deps.now() - m.since < ctx.cfg.mergeTimeoutMin * 60_000) {
      return 'kept';
    }
    return loopPolicy.onPark(
      ctx,
      m,
      `loop: gate fetch kept failing for PR ${prRef(ctx, pr)} — ${String(err)} — worktree ${m.item.worktreeDir}`
    );
  }
  // a successful fetch clears the strike count — isolated fetch errors
  // between healthy polls must not accumulate toward the park
  m.fetchErrors = 0;
  const act = memberAction(snap, m, {
    fixRounds: ctx.cfg.fixRounds,
    timeoutMs: ctx.cfg.mergeTimeoutMin * 60_000,
    now: ctx.deps.now(),
  });
  // loop.autoMerge — GitHub owns the merge once the worker armed
  // `gh pr merge --auto`: no supervisor merge call, no fix/rebase
  // rounds — threads never gate a landing the merge bot drives.
  // 'update' survives: a strict up-to-date repo would stall the
  // merge bot on a behind-base PR otherwise. 'land' keeps the
  // post-merge bookkeeping, 'closed'/'park' settle as usual — and
  // the member still parks on the mergeTimeoutMin clock: a PR GitHub
  // never lands (auto-merge unarmed, checks never green) must not
  // wait forever. pushItem withholds the arm order when
  // act.requireApproval is set — mirror that predicate here so the
  // gate keeps supervisor semantics (merge stays approval-gated)
  // instead of waiting on an auto-merge that was never armed.
  const autoMergeArmed = ctx.cfg.autoMerge && !ctx.act.requireApproval;
  const autoMergeTimedOut = ctx.deps.now() - m.since >= ctx.cfg.mergeTimeoutMin * 60_000;
  const kind =
    autoMergeArmed && act.kind !== 'land' && act.kind !== 'closed' && act.kind !== 'park'
      ? autoMergeTimedOut
        ? 'park'
        : act.kind === 'merge' || act.kind === 'fix' || act.kind === 'rebase'
          ? 'wait'
          : act.kind
      : act.kind;
  const parkWhy =
    act.kind === 'park'
      ? act.why
      : autoMergeTimedOut
        ? `auto-merge did not land after ${Math.round(ctx.cfg.mergeTimeoutMin)}m`
        : 'parked';
  // lifecycle — one `gate` row per settled gate decision (specs/
  // telemetry/bro-ub91h.md). 'wait' is a poll, not a verdict; every
  // other action is the round's record — fix/rebase carry the round
  // they are about to consume.
  const gateRow = (to: string, detail: Record<string, unknown>): void => {
    emitLifecycle(ctx.root, {
      kind: 'gate',
      bead: m.beads[0]!.id,
      pr,
      to,
      detail: {
        via: 'loop',
        sha: snap.headSha,
        threads: snap.openThreads,
        ...detail,
      },
    });
  };
  switch (kind) {
    case 'land':
      // landed externally while the member sat — close out, no merge call
      gateRow('green', { action: 'land' });
      return leave(m, await finalizeMerge(ctx, m.beads, m.item, pr, true));
    case 'merge':
      gateRow('green', { action: 'merge' });
      return leave(m, await finalizeMerge(ctx, m.beads, m.item, pr));
    case 'closed': {
      gateRow('closed', { action: 'closed' });
      // closePr cleanup: delete remote branch + reap worktree/branch
      deleteRemoteBranch(ctx, m.item.branch, 'on PR close');
      try {
        const rooted = processesRootedIn(m.item.worktreeDir);
        // a live process or uncommitted work keeps the checkout —
        // --force removes dirty trees, and those files have no other
        // copy (the base behavior kept the worktree on close)
        const st =
          rooted.length === 0
            ? gitTry(['-C', m.item.worktreeDir, 'status', '--porcelain'])
            : { code: 1, out: '', err: '' };
        if (rooted.length === 0 && st.code === 0 && st.out.trim() === '') {
          gitTry(['-C', m.item.worktreeDir, 'submodule', 'deinit', '-f', '--all']);
          gitTry(['-C', ctx.root, 'worktree', 'remove', '--force', m.item.worktreeDir]);
          gitTry(['-C', ctx.root, 'branch', '-D', m.item.branch]);
        } else if (rooted.length === 0) {
          ctx.tails.push(
            `worktree ${m.item.worktreeDir} kept on PR close — has uncommitted changes or status unreadable; branch ${m.item.branch} kept with it`
          );
          ctx.deps.error(`loop: ${ctx.tails.at(-1)}`);
        }
      } catch {
        /* best effort */
      }
      return loopPolicy.onPark(
        ctx,
        m,
        `loop: PR ${prRef(ctx, pr)} was closed unmerged — worktree ${m.item.worktreeDir}`
      );
    }
    case 'fix': {
      gateRow('blocked', { action: 'fix', round: m.rounds + 1, blockers: snap.blockers });
      const verdict = await respawnRound(ctx, m, () => runFixRound(ctx, m, pr, m.rounds, m.lane));
      // the snapshot that spawned the round must not be re-served —
      // a synchronous round (or a skipped spawn on already-resolved
      // threads) re-polls immediately and would re-trigger 'fix' on
      // the stale entry until the ttl lapses
      ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
      return verdict;
    }
    case 'rebase': {
      gateRow('blocked', { action: 'rebase', round: m.rounds + 1 });
      const verdict = await respawnRound(ctx, m, () =>
        runRebaseRound(ctx, m, pr, m.rounds, m.lane)
      );
      ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
      return verdict;
    }
    case 'update': {
      let ok: boolean;
      try {
        ok = ctx.deps.rev.updateBranch({ repo: ctx.repo, pr }, snap.headSha);
      } catch (err) {
        // a throw must not take the stack down — quiet keep; the
        // member's own deadline still bounds the retries
        ctx.deps.error(`loop ${prRef(ctx, pr)}: update-branch threw — ${String(err)}`);
        return 'kept';
      }
      ctx.deps.error(
        `loop ${prRef(ctx, pr)}: update-branch ${ok ? 'pushed a new head' : 'refused'}`
      );
      if (!ok) {
        // an update refusal IS the settle — same park the wait produced
        gateRow('blocked', { action: 'update', updated: false, blockers: snap.blockers });
        return loopPolicy.onPark(
          ctx,
          m,
          `loop: PR ${prRef(ctx, pr)} blocked: ${snap.blockers.join('; ')} — worktree ${m.item.worktreeDir}`
        );
      }
      gateRow('behind', { action: 'update', updated: true });
      // the pushed head obsoletes the feed entry this snap rode on —
      // the next poll fetches the new sha, not the stale BEHIND state
      ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
      m.updatedSha = snap.headSha;
      return 'active';
    }
    case 'wait':
      return 'kept';
    case 'park':
      gateRow('parked', { action: 'park', why: parkWhy });
      return loopPolicy.onPark(
        ctx,
        m,
        `loop: PR ${prRef(ctx, pr)} ${parkWhy} — worktree ${m.item.worktreeDir}`
      );
  }
}

/** A member leaving the stack ends its watch — the promise is kept.
 *  A 'parked' verdict also lands in the lifecycle journal: the claim's
 *  snooze is already written (parkBeads deferred it), the worktree
 *  stays for audit/resume — the row IS the transition. */

function failMemberService(ctx: LoopCtx, m: LoopMember, err: unknown): ServiceVerdict | undefined {
  m.serviceErrors += 1;
  ctx.deps.error(
    `loop: member ${m.beads[0]!.id} service failed (${m.serviceErrors}) — ${String(err)}`
  );
  if (m.serviceErrors < 3 && ctx.deps.now() - m.since < ctx.cfg.mergeTimeoutMin * 60_000) {
    m.nextPollAt = ctx.deps.now() + ctx.intervalS * 1000;
    return undefined;
  }
  return loopPolicy.onPark(
    ctx,
    m,
    `loop: member service kept failing — ${String(err)} — worktree ${m.item.worktreeDir}`
  );
}

/** One service pass over the stack, oldest-first — closure-first order. */

async function servicePass(ctx: LoopCtx): Promise<boolean> {
  let busy = false;
  // (a)/(b) service gate stack first
  for (const m of [...ctx.q.stack]) {
    let verdict: ServiceVerdict;
    try {
      verdict = await serviceMember(ctx, m); // NOSONAR — members service serially, oldest-first: a parallel pass would race the registry and claims
      // no strike reset here — serviceMember's skip paths return 'kept'
      // without servicing, so a blanket reset would zero live streaks;
      // serviceErrors clears inside serviceMember on a real dispatch
      // and the fetch arms own fetchErrors end-to-end (bro-cu3q8)
    } catch (err) {
      // the pass continues either way — one poison member must not
      // starve the stack behind it
      const failed = failMemberService(ctx, m, err);
      if (failed === undefined) {
        continue;
      }
      verdict = failed;
    }
    if (verdict === 'kept') {
      continue;
    }
    busy = true;
    if (verdict === 'active') {
      continue;
    }
    retireMember(ctx, m, verdict);
  }
  // (c) reconcile orphaned fleet PRs
  await reconcileFleet(ctx);
  // (d) ceiling check handled by tryClaim
  return busy;
}

/** A settled member leaves the stack: splice, release its ceiling
 *  reservation (landed or failed, no PR of its own keeps arriving to
 *  consume it), tally the verdict, and stamp the parked-claim set /
 *  post-merge sync / json row the verdict asks for. */

function retireMember(ctx: LoopCtx, m: LoopMember, verdict: keyof LoopQueue['tally']): void {
  ctx.q.stack.splice(ctx.q.stack.indexOf(m), 1);
  releaseMemberReservation(ctx, m);
  ctx.q.tally[verdict] += 1;
  if (verdict === 'parked') {
    for (const b of m.beads) {
      ctx.q.parkedClaims.add(b.id);
    }
  }
  if (verdict === 'landed') {
    syncAfterLand(ctx);
  }
  if (ctx.json) {
    ctx.deps.out(
      JSON.stringify({ bead: m.beads[0]!.id, beads: m.beads.map(b => b.id), result: verdict })
    );
  }
}

/** The filesystems a claim writes to — the worktree parent (sibling
 *  `<repo>--<id>` dirs hold the checkout plus bootstrap/agent litter,
 *  ~350M a slot) and the tmpdir (prompt files, agent scratch — /tmp
 *  filled mid-run in one of the recorded incidents). `bavail`, not
 *  `bfree`: the run is unprivileged, root-reserved blocks are not
 *  headroom. Cheap enough to re-probe every push — a merge's worktree
 *  removal re-admits the queue with no accounting of our own. An
 *  un-probeable path is skipped and named once per run: a watermark
 *  that cannot see reports, never gates (spec bro-2spp7). */

export function stackPlan(
  ctx: LoopCtx,
  bead: ReadyBead
): { slot: StackSlot | undefined; item: LoopItem } {
  const slot = ctx.deps.stackSlotFor(bead);
  const item = planItem(
    bead,
    ctx.root,
    slot === undefined ? undefined : { stack: { name: ctx.stack!, n: slot.n } }
  );
  return { slot, item };
}

/** `P · model M` provenance label — the lane announce and the dry-run
 *  render print the same pair. */

function planItemAndWorktree(
  ctx: LoopCtx,
  bead: ReadyBead
): { slot: StackSlot | undefined; item: LoopItem; reused: boolean } {
  let slot: StackSlot | undefined;
  let item!: LoopItem;
  let reused = false;
  const planAndCreate = (): void => {
    const plan = stackPlan(ctx, bead);
    slot = plan.slot;
    item = plan.item;
    ctx.deps.say(`\nloop: ${bead.id} → ${item.branch} @ ${item.worktreeDir}`);
    // a surviving worktree dir is reused as-is — its branch kept its
    // original base, so the stack edge only records on fresh creation
    const fresh = !existsSync(item.worktreeDir);
    reused = !fresh;
    ensureWorktree(ctx.root, item.branch, item.worktreeDir, slot?.base);
    if (fresh) {
      emitLifecycle(ctx.root, {
        kind: 'worktree',
        bead: bead.id,
        to: 'created',
        detail: {
          via: 'loop',
          worktree: item.worktreeDir,
          branch: item.branch,
          ...(slot?.base !== undefined ? { base: slot.base } : {}),
          ...(ctx.stack !== undefined ? { stack: ctx.stack } : {}),
        },
      });
    }
    if (fresh && slot?.edge !== undefined) {
      // same edge `work enter --stack` records — merge order travels
      ctx.deps.recordStackEdge(item.branch, slot.edge);
    }
  };
  const lockPath = ctx.deps.stackLockPath();
  if (ctx.stack !== undefined && lockPath === null) {
    ctx.deps.say('loop: could not resolve the git common dir — running without the stack lock');
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (lockPath === null) {
        planAndCreate();
      } else {
        withFileLock(lockPath, planAndCreate, { label: `stack ${ctx.stack} push lock` });
      }
      break;
    } catch (err) {
      if (!(err instanceof LockTimeout) || attempt >= 2) {
        throw err;
      }
    }
  }
  return { slot, item, reused };
}

// --- the gate stack: task-stack round-robin (spec bro-zsmwq) -----------------

/** A PR on the run's gate stack — claimed bead(s) + worktree + the
 *  per-member clock and its armed watch marker. `beads[0]` is the lead;
 *  a batch carries the whole clump (spec bro-nspj7). Entry order is
 *  service priority: the oldest member gets serviced first. */

function armMember(
  ctx: LoopCtx,
  beads: ReadyBead[],
  item: LoopItem,
  pr: number,
  lane: LoopLane
): LoopMember {
  emitLifecycle(ctx.root, {
    kind: 'pr-open',
    bead: beads[0]?.id,
    pr,
    to: 'open',
    detail: { via: 'loop', branch: item.branch },
  });
  const marker = watchBegin(ctx.root, {
    ...loopWatch(pr, prRef(ctx, pr), item.worktreeDir, ctx.cfg),
    bead: beads.map(b => b.id).join(','),
  });
  stampProjection(ctx, beads, pr);
  stampLoopPr(ctx, beads, item, pr);
  return {
    beads,
    item,
    pr,
    lane,
    marker,
    since: ctx.deps.now(),
    rounds: 0,
    fetchErrors: 0,
    serviceErrors: 0,
  };
}

/** The agent exited without a PR — the settle order: a self-reported
 *  verdict (the worker closed its own bead) wins; an instant exit is
 *  an environment crash to park loud, never a bead failure; anything
 *  else fails the clump and re-queues the still-open members. */

async function pushItem(ctx: LoopCtx, beads: ReadyBead[]): Promise<PushOutcome> {
  const lead = beads[0]!;
  // the lead's spawn lane resolves before any worktree exists — a
  // fleet.routing config error (an unknown `class:` label, a broken
  // chain) is deterministic: reopening would re-claim into the same
  // wall, so the lead parks claimed+noted like a spawn-environment
  // crash (bro-sovl3) while the clump's members release for re-pick —
  // their lanes were never resolved, the bad class is the lead's alone
  let lane: LoopLane;
  try {
    lane = await ctx.deps.laneFor(lead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.deps.matrixHold(err)) {
      // the matrix held this task (enforce no-fit/unanswered — spec
      // bro-v0pvd.1.1): defer the WHOLE clump so the beads hide from
      // ready and re-judge on wake — "stay queued, re-evaluate on next
      // state change", never a silent static-lane spawn and never a
      // hot re-claim loop. The claim custody record dies with the
      // released claims; the park row + note carry the verdict.
      // The lead was only PROBED on the registry path (claimStep owns
      // the real claim under the spawn lock, and it never ran) — take
      // the claim first or the defer writes assignee-clear onto a bead
      // this run never owned, racing a foreign claim's assignee with
      // it. A raced claim means a foreign owner re-judges the bead
      // themselves: park only the members this run did claim (a store
      // blip gets the same members-only park — never defer what we
      // cannot own). Leaving the lead open instead would re-claim and
      // re-judge it every tick — the hot loop the defer exists to
      // prevent.
      let parkSet = beads;
      if (ctx.deps.agents !== undefined) {
        try {
          parkSet = ctx.deps.claimUpTo([lead], 1).length > 0 ? beads : beads.slice(1);
        } catch {
          parkSet = beads.slice(1);
        }
      }
      const undeferred = parkBeads(ctx, parkSet, `loop: ${msg}`);
      if (undeferred.length === 0) {
        // every member deferred — the claims released into the snooze,
        // so the custody record dies with them
        ctx.deps.endRun(loopSlug(lead.id));
      } else {
        // a member whose defer write failed is still in_progress under
        // this run's claim — deleting the custody record would orphan
        // it into the litter sweep mid-hold. Retain the record instead:
        // the claim stays owned until this loop exits and the sweep
        // releases it back to the queue. (Reopening here could
        // hot-loop a backend with no defer concept — the bead would
        // re-claim, re-judge, and fail to park every tick.)
        ctx.deps.say(
          `loop: ${undeferred.map(b => b.id).join(', ')} could not defer — ` +
            `custody retained until exit`
        );
      }
      ctx.deps.say(`loop: ${lead.id} held by fleet.matrix — ${msg} — parked`);
      return { kind: 'done', result: 'parked' };
    }
    // the registry path only probed the lead (claimStep owns the real
    // claim under the spawn lock) — take the claim here or the park
    // can't hold the bead off the queue and it re-fails every pass.
    // A raced claim means a foreign owner; the note still lands.
    if (ctx.deps.agents !== undefined) {
      try {
        ctx.deps.claimUpTo([lead], 1);
      } catch {
        /* best-effort park claim */
      }
    }
    noteBead(ctx, lead.id, `loop: route resolution failed — ${msg} — parked`);
    ctx.deps.say(`loop: ${lead.id} route failed — ${msg} — parked`);
    for (const b of openBeads(ctx, beads.slice(1))) {
      reopenBead(ctx, b.id);
    }
    return { kind: 'done', result: 'parked' };
  }
  // resolved here, not earlier — a member that landed since the last
  // push correctly yields the default branch as the next base.
  let slot: StackSlot | undefined;
  let item!: LoopItem;
  let reused = false;
  // the claims this run actually holds — claimUpTo owns the lead only
  // outside the registry path; there the lead is a PROBE until
  // claimStep lands it under the spawn lock, so a pre-spawn settle
  // that reopened it could steal a foreign loop's fresh claim
  const ours = ctx.deps.agents === undefined ? beads : beads.slice(1);
  try {
    ctx.stage = 'worktree';
    const planned = planItemAndWorktree(ctx, lead);
    slot = planned.slot;
    item = planned.item;
    reused = planned.reused;
  } catch (err) {
    for (const b of openBeads(ctx, ours)) {
      noteBead(
        ctx,
        b.id,
        `loop: worktree failed — ${err instanceof Error ? err.message : String(err)}`
      );
      reopenBead(ctx, b.id);
    }
    // the claim-time custody record (claimClump) dies with the claim
    ctx.deps.endRun(loopSlug(lead.id));
    return { kind: 'done', result: 'failed' };
  }
  // re-stamp claim custody (bro-ho09d) — the claimClump record already
  // proves a live owner; this refresh names the verified worktree dir
  // and log for the check-in readers
  ctx.deps.beginRun({
    beadId: lead.id,
    beadIds: beads.map(b => b.id),
    slug: loopSlug(lead.id),
    pid: process.pid,
    pidStart: procStat(process.pid)?.start,
    startedAt: new Date(ctx.deps.now()).toISOString(),
    worktree: item.worktreeDir,
    log: ctx.deps.runLog(loopSlug(lead.id)) ?? '',
  });
  // A woken park re-claims into the worktree it kept — and possibly
  // the open PR it kept too. Only a REUSED worktree can carry that PR:
  // when the branch already gates on one, re-arm the watch and rejoin
  // the gate — re-running the finished work order would redo landed
  // work and shove a duplicate push at the same PR. A lookup error
  // can't prove a PR absent, so it falls through to the spawn exactly
  // as before — the post-spawn findPr stays the backstop.
  if (reused) {
    ctx.stage = 'pr lookup';
    const parkedPr = findPr(ctx, item.branch);
    if (typeof parkedPr === 'number') {
      // registry mode leaves the lead a mere probe until spawnWorker's
      // claimStep — with no spawn to land it, claim it the non-registry
      // way or the bead snaps back to ready and re-parks forever
      if (ctx.deps.agents !== undefined && ctx.deps.claimUpTo([lead], 1).length === 0) {
        for (const b of openBeads(ctx, ours)) {
          reopenBead(ctx, b.id);
        }
        ctx.deps.endRun(loopSlug(lead.id));
        return { kind: 'done', result: 'failed' };
      }
      ctx.deps.say(`loop: ${lead.id} re-attaches to ${prRef(ctx, parkedPr)} — no re-spawn`);
      ctx.deps.endRun(loopSlug(lead.id));
      return { kind: 'member', member: armMember(ctx, beads, item, parkedPr, lane) };
    }
  }
  ctx.stage = 'bootstrap';
  if (!runBootstrap(ctx, ours, item)) {
    ctx.deps.endRun(loopSlug(lead.id));
    return { kind: 'done', result: 'failed' };
  }
  const prompt = buildWorkPrompt(
    beads,
    item.branch,
    slot?.base,
    slot?.bottom,
    ctx.backend,
    ctx.cfg.autoMerge && !ctx.act.requireApproval
  );
  ctx.stage = 'prompt write';
  try {
    writePrompt(item, prompt);
  } catch (err) {
    // a dead fs must not strand this run's claims in_progress — same
    // settle as the worktree failure above
    for (const b of openBeads(ctx, ours)) {
      noteBead(
        ctx,
        b.id,
        `loop: prompt write failed — ${err instanceof Error ? err.message : String(err)}`
      );
      reopenBead(ctx, b.id);
    }
    ctx.deps.endRun(loopSlug(lead.id));
    return { kind: 'done', result: 'failed' };
  }
  ctx.stage = 'agent spawn';
  if (ctx.deps.agents !== undefined) {
    // the registry path — the member comes back worker-pending and its
    // .exit poll rides the SAME service pass as every PR gate
    // (spec bro-zpa93): a worker that runs for hours starves nothing
    const member: LoopMember = {
      beads,
      item,
      lane,
      marker: null,
      since: ctx.deps.now(),
      rounds: 0,
      fetchErrors: 0,
      serviceErrors: 0,
      prompt,
    };
    try {
      await ctx.deps.spawnWorker(member, prompt);
    } catch (err) {
      return settleSpawnRefusal(ctx, member, err);
    }
    // settle a worker that already died before the push returns (e.g. a
    // provider wall) so the hold can take effect before the next claim
    // (bro-36bhc) — a still-running worker stays 'kept' and the member
    // joins the gate as usual.
    await ctx.deps.sleepMs(200);
    const verdict = await serviceWorker(ctx, member);
    if (verdict === 'kept' || verdict === 'active') {
      // custody transfers to the agent registry entry — claimStep landed
      // the lead's claim under the spawn lock (bro-ho09d). The run
      // record does NOT retire here (bro-wg896): re-stamped to the
      // worker inside spawnWorker, it stays the check-in plane until the
      // armed watch marker takes custody at the settle.
      return { kind: 'member', member };
    }
    return { kind: 'done', result: verdict, settled: true };
  }
  // raw-template arm: route through the same session-quota admission as
  // the registry spawn so the fleet/session planes agree on live workers
  // (spec bro-9h86l / bro-0fbdp)
  const templateReservationKey = `loop-${lead.id}`;
  let templateReservation: string | undefined;
  let crossKindReservationsPush: string[] = [];
  try {
    const admission = ctx.deps.admitTemplate(
      lane,
      { molStep: lead.id, prompt, repoRoot: item.worktreeDir },
      templateReservationKey
    );
    templateReservation = admission.reservation;
    crossKindReservationsPush = admission.crossKind;
  } catch (err) {
    // admission threw before returning — every claim it held was
    // already handed back inside admitLaneSessions
    ctx.deps.endRun(loopSlug(lead.id));
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof SpawnError && err.kind === 'cap') {
      for (const b of openBeads(ctx, ours)) {
        noteBead(ctx, b.id, `loop: session quota admission failed — ${msg}`);
        reopenBead(ctx, b.id);
      }
      ctx.deps.say(`loop: fleet full — ${err.message}; pushes hold for the next pass`);
      return { kind: 'hold', why: err.message };
    }
    parkBeads(ctx, ours, `loop: session quota admission failed — ${msg}`);
    ctx.deps.say(`loop: ${lead.id} spawn refused — ${msg}`);
    return { kind: 'done', result: 'parked' };
  }
  // no shared store to pin a claim/exit record against — the awaited
  // spawn keeps the serial semantics (documented fallback)
  const spawnAt = ctx.deps.now();
  let code: number | null = null;
  try {
    code = await ctx.deps.spawnTemplate(
      lane,
      beads.map(b => b.id),
      clumpTitle(beads),
      item.promptFile,
      item.worktreeDir,
      templateReservationKey
    );
  } catch (err) {
    if (templateReservation !== undefined) {
      releaseSessionSlot(templateReservation);
    }
    releaseSessionStart(crossKindReservationsPush);
    throw err;
  }
  if (templateReservation !== undefined) {
    releaseSessionSlot(templateReservation);
  }
  releaseSessionStart(crossKindReservationsPush);
  // agent wall-time — measured before findPr's gh call; a slow lookup
  // must not inflate an instant crash past the crashExitMs threshold
  const elapsed = ctx.deps.now() - spawnAt;
  ctx.stage = 'pr lookup';
  const pr = findPr(ctx, item.branch);
  if (pr === 'lookup-error') {
    parkBeads(
      ctx,
      beads,
      `loop: PR lookup failed for ${item.branch} — worktree ${item.worktreeDir}`
    );
    return { kind: 'done', result: 'parked' };
  }
  if (pr === null) {
    return { kind: 'done', result: settleNoPr(ctx, beads, item, code, elapsed) };
  }
  // custody transfers to the armed watch — the run record's job is done
  ctx.deps.endRun(loopSlug(lead.id));
  return { kind: 'member', member: armMember(ctx, beads, item, pr, lane) };
}

/** The PR-armed moment, shared by the post-spawn discovery and the
 *  pre-spawn reattach of a woken park. The loop IS the watcher — arm
 *  the same marker `act wait` drops (bro-z0k2u) for the member's whole
 *  stack tenure, not per poll: a reboot-killed loop leaves a dead
 *  marker `bro act rearm` resurrects instead of the PR sitting silently
 *  unwatched. `bead` rides the marker so the resurrected wait can run
 *  the finalizeMerge half the dead loop never reached — merge lands,
 *  claims close (bro-q6ppv); a clump's whole id list rides
 *  comma-joined. The marker lands BEFORE the stamp — a stall or death
 *  inside stampProjection's tracker calls must not strand the open PR
 *  markerless. */

function pickLead(ctx: LoopCtx, candidates: ReadyBead[]): ReadyBead | undefined {
  if (ctx.deps.agents === undefined) {
    for (const b of candidates) {
      if (!claimableByLadder(ctx, b, true)) {
        continue;
      }
      const got = ctx.deps.claimUpTo([b], 1)[0];
      if (got !== undefined) {
        return got;
      }
    }
    return undefined;
  }
  let statuses: Map<string, string> | undefined;
  return candidates.find(b => {
    // lazily fetched — a cheap status prefetch ahead of the verdict
    // probe, which costs the ready/show reads
    const s = (statuses ??= beadStatuses(ctx, candidates)).get(b.id);
    return s !== 'in_progress' && s !== 'closed' && claimableByLadder(ctx, b, true);
  });
}

/** Members claim one at a time — a raced-away member skips, and a
 *  mid-fill store failure must not sink the run with half the clump
 *  claimed: the lead proceeds with whatever members did claim. */

function claimMembers(ctx: LoopCtx, want: ReadyBead[]): ReadyBead[] {
  const members: ReadyBead[] = [];
  for (const m of want) {
    // members join only on `step` — a `gate` verdict means the
    // member's own PR is already in flight; folding it into this
    // clump would re-work a gated branch (spec bro-oy3k1.6)
    if (!claimableByLadder(ctx, m, false)) {
      continue;
    }
    try {
      const got = ctx.deps.claimUpTo([m], 1)[0];
      if (got === undefined) {
        continue; // raced away
      }
      members.push(got);
    } catch (err) {
      ctx.deps.error(
        `loop: clump member claim failed — ${String(err)} — proceeding with a partial clump`
      );
      break;
    }
  }
  return members;
}

/** Claim the next work item — the top ready bead, plus its compatible
 *  tail when `loop.batch` > 1 (spec bro-nspj7: the clump binds on the
 *  lead's affinity key — spec/epic/area/path — and never reaches past
 *  the priority floor or the --max budget). Undefined when the queue
 *  drains. A foreign-only remainder must not look like a drained
 *  queue: 'done' would hide work a shared db still advertises. */

function claimableByLadder(ctx: LoopCtx, b: ReadyBead, allowGate: boolean): boolean {
  try {
    const v = rigNext(ctx.root, b.id, { store: ctx.deps.tasks }).verdict;
    return v === 'step' || (allowGate && v === 'gate');
  } catch {
    return true;
  }
}

/** The registry's claimStep owns the lead's claim under the spawn lock
 *  (spec bro-zpa93) — a loop-side pre-claim reads as "claimed outside
 *  the agent registry" and the spawn refuses it. The pick only
 *  re-probes the store so a raced-away bead still skips down the
 *  candidate chain exactly as claimUpTo's claim loop did. */

function claimClump(ctx: LoopCtx, seen: Set<string>, budget: number): ReadyBead[] | undefined {
  const { candidates, foreign } = ctx.deps.claimCandidates(seen, ctx.scope);
  const lead = pickLead(ctx, candidates);
  if (!lead) {
    if (foreign > 0) {
      ctx.deps.say(`loop: ${foreign} foreign-scope bead(s) remain — not claimable in this project`);
    }
    return undefined;
  }
  // claim custody — the litter sweep treats in_progress with no live
  // owner as an orphan (bro-ho09d). The worker's pid only exists after
  // pushItem's spawn; until then the loop process itself is the live
  // owner, so the claim → worktree → bootstrap → spawn chain can't
  // read as abandonment to a racing sweep. The worktree path is the
  // deterministic planItem naming — planItemAndWorktree reuses it
  // verbatim. pushItem re-stamps the record; the spawn re-stamps it
  // under the worker's pid (spawnAgent's beginLoopRun, or spawnWorker's
  // on the registry path — bro-wg896).
  claimCustody(ctx, lead, [lead.id]);
  // solo fast path — batch off, no budget for a second member, or a
  // lead that can't clump (urgent, keyless, or `solo`-labelled)
  if (ctx.cfg.batch < 2 || budget < 2) {
    return [lead];
  }
  const want = clumpMembers(
    lead,
    candidates.filter(b => b.id !== lead.id),
    { size: Math.min(ctx.cfg.batch, budget), minPriority: ctx.cfg.batchMinPriority }
  );
  if (want.length === 0) {
    return [lead];
  }
  const members = claimMembers(ctx, want);
  if (members.length > 0) {
    ctx.deps.say(
      `loop: batch of ${members.length + 1} — ${lead.id} + ${members.map(b => b.id).join(', ')}`
    );
    // members claimed after the lead — widen custody so their
    // in_progress also traces to this run's owner pid
    claimCustody(ctx, lead, [lead.id, ...members.map(b => b.id)]);
  }
  return [lead, ...members];
}

/** The run record as a claim-custody marker: loop-pid owned until
 *  spawnAgent re-stamps it with the worker's. Without it an
 *  in_progress bead between `bd --claim` and the worker fork reads as
 *  an orphan to `bro work prune --loop` and gets released mid-setup. */

function claimCustody(ctx: LoopCtx, lead: ReadyBead, beadIds: string[]): void {
  const slug = loopSlug(lead.id);
  ctx.deps.beginRun({
    beadId: lead.id,
    beadIds,
    slug,
    pid: process.pid,
    pidStart: procStat(process.pid)?.start,
    startedAt: new Date(ctx.deps.now()).toISOString(),
    worktree: worktreePathFor(ctx.root, slug),
    log: ctx.deps.runLog(slug) ?? '',
  });
}

/** Post-merge cascade after a landed stack member — retarget + rebase
 *  whatever stacked on top of it before the next item runs. */

function queueDrained(ctx: LoopCtx, seen: Set<string>): boolean {
  let c: { candidates: ReadyBead[]; foreign: number };
  try {
    c = ctx.deps.claimCandidates(seen, ctx.scope);
  } catch {
    return false;
  }
  const statuses = beadStatuses(ctx, c.candidates);
  const claimable = c.candidates.some(b => {
    const s = statuses.get(b.id);
    return s !== 'in_progress' && s !== 'closed';
  });
  if (claimable) {
    return false;
  }
  if (c.foreign > 0) {
    ctx.deps.say(`loop: ${c.foreign} foreign-scope bead(s) remain — not claimable in this project`);
  }
  return true;
}

/** The engine's verdict gates the pick (spec bro-oy3k1.6): a parked
 *  frame, a live registry worker, or a foreign/dep-held claim are not
 *  claimable even when raw status still reads open. `allowGate` — the
 *  lead pick keeps `gate` claimable (the loop owns the re-attach
 *  contract for a woken park with a PR up); clump members join on
 *  `step` only. The probe reads through the caller's facade store and
 *  a throwing probe treats the candidate as claimable — racedAway
 *  stays the guard; a blind probe must not mask work. */

function syncAfterLand(ctx: LoopCtx): void {
  if (ctx.stack === undefined) {
    return;
  }
  try {
    for (const line of ctx.deps.syncStackLines()) {
      ctx.deps.say(`loop stack sync:${line}`);
    }
  } catch (err) {
    ctx.deps.say(`loop: stack sync failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildBeadsBySlug(ctx: LoopCtx): Map<string, ReconcileBead> | null {
  const out = new Map<string, ReconcileBead>();
  try {
    const rows = ctx.deps.tasks.list({ all: true });
    if (rows.length >= TASK_LIST_SNAPSHOT_CAP) {
      return null;
    }
    for (const r of rows) {
      if (!r?.id) continue;
      const slug = loopSlug(r.id);
      if (!out.has(slug)) {
        out.set(slug, { id: r.id, status: r.status });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Get all open fleet PRs (headRef + pr). Returns null if listing is unknown/incomplete. */

function fleetPrMemberIds(ctx: LoopCtx, row: FleetPrRow): string[] | null {
  if (typeof ctx.deps.rev.prBody !== 'function') {
    return null;
  }
  let meta: Record<string, unknown>;
  try {
    meta = bodyMeta(ctx.deps.rev.prBody({ repo: ctx.repo, pr: row.pr }));
  } catch {
    return null;
  }
  const raw = meta.bead;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  const ids = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return ids.length === 0 ? null : ids;
}

/** Member ids → bead rows against a listing — a member the listing
 *  can't find reads 'unknown', and 'unknown' is never dead. */

function memberBeads(
  ids: readonly string[],
  beadsById: ReadonlyMap<string, ReconcileBead>
): ReconcileBead[] {
  return ids.map(id => beadsById.get(id) ?? { id, status: 'unknown' });
}

/** Reconcile orphaned fleet PRs not on the current stack. */

async function reconcileFleet(ctx: LoopCtx): Promise<void> {
  try {
    const fleet = ctx.deps.openFleetPrs();
    if (fleet === null || fleet.length === 0) return;
    const stackPrs = new Set<number>();
    const stackBranches = new Set<string>();
    for (const m of ctx.q.stack) {
      if (m.pr !== undefined) stackPrs.add(m.pr);
      // a worker-pending member has no PR number until its .exit lands
      // — its about-to-open PR protects by branch, not by number
      stackBranches.add(m.item.branch);
    }
    const beadsBySlug = buildBeadsBySlug(ctx);
    if (beadsBySlug === null) {
      // Bead listing unknown — skip reconciliation to avoid false closures
      return;
    }
    const beadsById = new Map([...beadsBySlug.values()].map(b => [b.id, b] as const));
    for (const row of fleet) {
      if (stackPrs.has(row.pr) || stackBranches.has(row.headRef)) continue;
      const bead = beadForHead(row, beadsBySlug);
      let verdict = orphanVerdict(row, bead);
      if (verdict.kind === 'close') {
        // a batch head shares its branch across members — the lead's
        // status is not the clump's. Any member not positively closed
        // (open, in_progress, deferred, unreadable) keeps the PR. A
        // `bead:` trailer overrides the single-bead read on ANY head;
        // a `loop/` head is stamped at open, so a missing trailer
        // there is 'unknown' — and unknown never buries a batch.
        const ids = fleetPrMemberIds(ctx, row);
        if (ids !== null) {
          verdict = orphanVerdict(row, bead, memberBeads(ids, beadsById));
        } else if (row.headRef.startsWith('loop/')) {
          verdict = { kind: 'keep' };
        }
      }
      if (verdict.kind !== 'close') {
        continue;
      }
      // the verdict rode a snapshot a whole pass old — reread before
      // burying: a bead reopened since must not close its live work
      const fresh = buildBeadsBySlug(ctx);
      if (fresh === null) {
        continue;
      }
      const freshBead = beadForHead(row, fresh);
      const freshById = new Map([...fresh.values()].map(b => [b.id, b] as const));
      const freshIds = fleetPrMemberIds(ctx, row);
      const recheck =
        freshIds === null && row.headRef.startsWith('loop/')
          ? { kind: 'keep' as const }
          : orphanVerdict(
              row,
              freshBead,
              freshIds === null ? undefined : memberBeads(freshIds, freshById)
            );
      if (recheck.kind !== 'close') {
        continue;
      }
      try {
        let closed = false;
        if (typeof ctx.deps.rev.closePr === 'function') {
          try {
            ctx.deps.rev.closePr({ repo: ctx.repo, pr: row.pr });
            closed = true;
          } catch {
            closed = false;
          }
        }
        if (!closed && typeof ctx.deps.rev.closePr !== 'function') {
          // a host with no closePr keeps the PR — name why once per
          // run, then let the next pass check silently again
          if (!ctx.q.unclosableNoted.has(row.pr)) {
            ctx.q.unclosableNoted.add(row.pr);
            ctx.deps.say(
              `loop: reconcile keeps ${prRef(ctx, row.pr)} (${row.headRef}) — host has no closePr; ${verdict.why}`
            );
          }
          continue;
        }
        if (!closed) {
          // closePr exists but failed; avoid reporting a close and retrying aggressively
          continue;
        }
        ctx.deps.say(
          `loop: reconcile close ${prRef(ctx, row.pr)} (${row.headRef}) — ${verdict.why}`
        );
        deleteRemoteBranch(ctx, row.headRef, 'after reconcile close');
        try {
          // try to remove local worktree/branch if any
          try {
            const trees = ctx.deps.worktrees();
            if (trees !== null) {
              for (const t of trees) {
                if (t.branch === row.headRef && t.path) {
                  const rooted = processesRootedIn(t.path);
                  // a live process or uncommitted work keeps the
                  // checkout — --force removes dirty trees, and those
                  // files have no other copy
                  const st =
                    rooted.length === 0
                      ? gitTry(['-C', t.path, 'status', '--porcelain'])
                      : { code: 1, out: '', err: '' };
                  if (rooted.length === 0 && st.code === 0 && st.out.trim() === '') {
                    gitTry(['-C', t.path, 'submodule', 'deinit', '-f', '--all']);
                    const rm = gitTry(['-C', ctx.root, 'worktree', 'remove', '--force', t.path]);
                    if (rm.code !== 0) {
                      ctx.tails?.push(
                        `worktree ${t.path} not removed (orphan reconcile) — ${rm.err.trim()}`
                      );
                    }
                  } else {
                    ctx.tails?.push(
                      rooted.length > 0
                        ? `worktree ${t.path} kept (orphan reconcile) — hosts live process(es): ${rooted.map(h => h.pid).join(', ')}; branch ${row.headRef} kept with it`
                        : `worktree ${t.path} kept (orphan reconcile) — has uncommitted changes or status unreadable; branch ${row.headRef} kept with it`
                    );
                  }
                  break;
                }
              }
            }
          } catch {
            /* best effort */
          }
          // Only delete branch if no worktree is still using it
          try {
            const trees2 = ctx.deps.worktrees();
            if (trees2 !== null) {
              const stillCheckedOut = trees2.some(t => t.branch === row.headRef);
              if (!stillCheckedOut) {
                const br = gitTry(['-C', ctx.root, 'branch', '-D', row.headRef]);
                if (br.code !== 0) {
                  ctx.tails?.push(`branch ${row.headRef} not deleted — ${br.err.trim()}`);
                }
              } else {
                ctx.tails?.push(`branch ${row.headRef} not deleted — checked out in a worktree`);
              }
            } else {
              const br = gitTry(['-C', ctx.root, 'branch', '-D', row.headRef]);
              if (br.code !== 0) {
                ctx.tails?.push(`branch ${row.headRef} not deleted — ${br.err.trim()}`);
              }
            }
          } catch {
            const br = gitTry(['-C', ctx.root, 'branch', '-D', row.headRef]);
            if (br.code !== 0) {
              ctx.tails?.push(`branch ${row.headRef} not deleted — ${br.err.trim()}`);
            }
          }
        } catch {
          /* best effort */
        }
      } catch (err) {
        ctx.deps.error(`loop: reconcile failed for ${prRef(ctx, row.pr)} — ${String(err)}`);
      }
    }
  } catch (err) {
    ctx.deps.error(`loop: reconcile error — ${String(err)}`);
  }
}

/** One member's thrown service failure → kept-with-backoff (undefined)
 *  under the strike budget, or the parked verdict past it. A member's
 *  settle can still throw on infra — the task store wedged mid-write,
 *  a dead spawn, a failed projection call. That's a member failure,
 *  never a dead supervisor (bro-cu3q8): it strikes its own
 *  serviceErrors budget — the same give-up contract the fetch arms
 *  run on fetchErrors (under 3 strikes and inside mergeTimeoutMin the
 *  member is kept and its re-poll holds an interval — a wedged store
 *  throws instantly, so without the pause every tick re-strikes); past
 *  the budget it parks exactly like the fetch arm. */

export function diskProbes(ctx: LoopCtx, warned?: Set<string>): DiskProbe[] {
  const out: DiskProbe[] = [];
  for (const p of new Set([dirname(ctx.root), tmpdir()])) {
    const probe = probeDisk(ctx, p, warned);
    if (probe !== undefined) {
      out.push(probe);
    }
  }
  return out;
}

/** statfs one path → DiskProbe. bigint probe — bavail×bsize on a
 *  multi-EB fs overflows the number range mid-multiply; the DiskProbe
 *  contract is a number, so saturate at MAX_SAFE_INTEGER (a free that
 *  large admits every floor anyway). A failed path warns once per run
 *  when `warned` is provided. */

export function probeDisk(ctx: LoopCtx, p: string, warned?: Set<string>): DiskProbe | undefined {
  try {
    const s = statfsSync(p, { bigint: true });
    const free = s.bavail * s.bsize;
    return {
      path: p,
      freeBytes: free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (warned === undefined) {
      ctx.deps.error(`loop: disk probe failed for ${p} — ${msg}`);
    } else if (!warned.has(p)) {
      warned.add(p);
      ctx.deps.error(`loop: disk probe failed for ${p} — ${msg} — watermark blind there`);
    }
    return undefined;
  }
}

/** A done-path push outcome — tallied, the park journaled (it never
 *  passed through leave(), so the held claim is the transition the
 *  journal wants), and echoed under --json. */

async function settleOutcome(
  ctx: LoopCtx,
  ids: string[],
  out: Extract<PushOutcome, { kind: 'done' }>
): Promise<void> {
  ctx.q.tally[out.result] += 1;
  // the outcome report (spec bro-0ykhg.4) — a terminal non-merge verdict
  // flows back to the router by decision id: the bead's pin or the
  // journal's run-link reconciliation resolves it. 'landed'/'closed'
  // are merge-lifecycle results the act path owns — reporting them
  // here would double the merge authority's verdict.
  if (out.result === 'failed' || out.result === 'parked') {
    try {
      await ctx.deps.reportOutcome(ids[0]!, out.result);
    } catch {
      /* the outbox is durable — a failed pass retries on reconcile,
         and the park journal below still runs */
    }
  }
  if (out.result === 'parked') {
    for (const id of ids) {
      ctx.q.parkedClaims.add(id);
    }
    // a done outcome serviceWorker already left() skips the row —
    // two park rows for the same beads would double-count telemetry
    if (out.settled !== true) {
      emitLifecycle(ctx.root, {
        kind: 'park',
        bead: ids[0],
        to: 'parked',
        detail: {
          via: 'loop',
          ...(ids.length > 1 ? { beads: ids.join(',') } : {}),
        },
      });
    }
  }
  if (ctx.json) {
    ctx.deps.emitJson({ bead: ids[0], beads: ids, result: out.result });
  }
}

/** One admitted-but-PR-less claim, as a file other loop processes can
 *  count. The ceiling lock only spans the check; the claim→spawn→open
 *  window sits outside it, and two loops that each read n<max in that
 *  window both admit — the listing can't see a PR that doesn't exist
 *  yet. A reservation file closes the window: written under the lock
 *  at admission, re-stamped with the branch once the member exists,
 *  consumed when the branch's PR lists, released on every
 *  non-member outcome and on member splice, and swept when the
 *  owning pid is dead. Lives in the COMMON git dir so linked
 *  worktrees of this clone coordinate (separate clones share only
 *  the remote listing — a remote reservation ref is follow-up work).
 */

function sweepCeilingReservations(dir: string, fleet: FleetPrRow[]): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const heads = new Set(fleet.map(r => r.headRef));
  let live = 0;
  for (const name of names) {
    if (!name.startsWith(CEILING_RES_PREFIX) || !name.endsWith('.json')) {
      continue;
    }
    const p = join(dir, name);
    let res: CeilingRes | undefined;
    try {
      res = JSON.parse(readFileSync(p, 'utf8')) as CeilingRes;
    } catch {
      res = undefined;
    }
    if (res !== undefined && res.branch !== undefined && heads.has(res.branch)) {
      try {
        unlinkSync(p);
      } catch {
        /* raced removal — fine */
      }
      continue;
    }
    if (res !== undefined && typeof res.pid === 'number' && !pidAlive(res.pid, res.pidStart)) {
      try {
        unlinkSync(p);
      } catch {
        /* raced removal — fine */
      }
      continue;
    }
    live += 1;
  }
  return live;
}

/** Write one reservation under the caller's lock — null when the file
 *  can't be proven to exist (the slot then counts as held, not free). */

function reserveCeilingSlot(ctx: LoopCtx, dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${CEILING_RES_PREFIX}${process.pid}-${ctx.deps.now()}.json`);
    const res: CeilingRes = {
      pid: process.pid,
      pidStart: procStat(process.pid)?.start,
      ts: ctx.deps.now(),
    };
    writeFileSync(p, JSON.stringify(res), 'utf8');
    return p;
  } catch {
    return null;
  }
}

/** The member's branch joined the reservation — the file now names
 *  the head its future PR will list under, so the next sweep can tell
 *  'worker still spawning' from 'listing already counts this slot'. */

function stampCeilingReservation(file: string, branch: string): void {
  try {
    const res = JSON.parse(readFileSync(file, 'utf8')) as CeilingRes;
    res.branch = branch;
    writeFileSync(file, JSON.stringify(res), 'utf8');
  } catch {
    /* the file stays counted either way — a branchless reservation is the same held slot */
  }
}

function releaseCeilingFile(file: string | null): void {
  if (file === null) {
    return;
  }
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** A member left the stack — its reservation (if the PR never listed
 *  it away) dies with the tenure. */

function releaseMemberReservation(ctx: LoopCtx, member: LoopMember): void {
  const file = ctx.q.ceilingRes.get(member.item.branch);
  if (file === undefined) {
    return;
  }
  ctx.q.ceilingRes.delete(member.item.branch);
  releaseCeilingFile(file);
}

/** The push half of a tick — true when a bead was claimed (drained or
 *  not, the fresh member's first poll wants an immediate pass, not an
 *  idle interval). False when the push was skipped — queue drained,
 *  --max spent, or the gate stack full. */

async function tryClaim(ctx: LoopCtx): Promise<boolean> {
  const maxed = ctx.cfg.maxItems > 0 && ctx.q.claimed >= ctx.cfg.maxItems;
  if (ctx.q.drained || maxed) {
    return false;
  }
  // past the gate the push is unheld — a stale hold stage must not
  // shadow this tick's own verdict (idle names from here re-set their
  // own marker: diskHeld, holdStage, or a fresh claim stage)
  ctx.q.holdStage = undefined;
  if (ctx.deps.now() < ctx.q.pushHoldUntil) {
    // a held push still owes the drain verdict — an empty queue behind
    // the wall reports done instead of idling until the reset
    if (queueDrained(ctx, ctx.q.seen)) {
      ctx.q.drained = true;
    }
    return false;
  }
  // a member sitting in a provider wall wait holds pushes (bro-36bhc) —
  // claiming the next bead into the same wall burns its spawn. The drain
  // check still runs: an empty queue behind the wall owes the done
  // verdict, not an infinite hold.
  const wallWaiters = ctx.q.stack.filter(m => m.wallWaitUntil !== undefined);
  if (wallWaiters.length > 0) {
    if (queueDrained(ctx, ctx.q.seen)) {
      ctx.q.drained = true;
      return false;
    }
    const until = Math.min(...wallWaiters.map(m => m.wallWaitUntil as number));
    if (!ctx.q.wallHeld) {
      ctx.q.wallHeld = true;
      ctx.deps.say('loop: rate wall — pushes hold until the reset');
    }
    ctx.q.pushHoldUntil = Math.max(ctx.q.pushHoldUntil, until);
    return false;
  }
  if (ctx.q.wallHeld) {
    ctx.q.wallHeld = false;
    ctx.deps.say('loop: wall cleared — pushes resume');
  }
  // the stack cap is consulted AFTER the ceiling check — a full stack
  // must not silence the ceiling-hold line: at/over the fleet ceiling
  // the hold belongs to the ceiling, and this log is the only place an
  // operator learns that pushes are held for it (#791)
  const stackFull = ctx.q.stack.length >= ctx.cfg.maxOpen;
  // Hard ceiling on TOTAL open fleet PRs — plus every admitted-but-
  // PR-less claim a sibling loop holds a reservation for. The
  // reservation is what makes the bound atomic: without it two loops
  // sharing this common dir can both read n<max in the claim→spawn→open
  // window and each admit a clump.
  let ceilingRes: string | null = null;
  if (ctx.cfg.maxOpenTotal > 0) {
    try {
      const fleetCommon = gitCommonDir(ctx.root);
      const resDir = fleetCommon === null ? null : join(fleetCommon, 'bro', 'ceiling.reserved');
      let held = false;
      const doCeilCheck = (): boolean => {
        const fleet = ctx.deps.openFleetPrs();
        if (fleet === null) {
          // a listing that can't be produced holds too (fail closed)
          if (!ctx.claimsHeld) {
            ctx.claimsHeld = { open: -1, max: ctx.cfg.maxOpenTotal };
            ctx.deps.say(`loop: claims held — ceiling unknown/${ctx.cfg.maxOpenTotal}`);
          }
          return true;
        }
        const pending = resDir === null ? 0 : sweepCeilingReservations(resDir, fleet);
        const open = fleet.length + pending;
        if (ceilingHeld(open, ctx.cfg.maxOpenTotal)) {
          if (
            !ctx.claimsHeld ||
            ctx.claimsHeld.open !== open ||
            ctx.claimsHeld.max !== ctx.cfg.maxOpenTotal
          ) {
            ctx.claimsHeld = { open, max: ctx.cfg.maxOpenTotal };
            ctx.deps.say(
              `loop: claims held — ceiling ${fleet.length} open + ${pending} reserved/${ctx.cfg.maxOpenTotal}`
            );
          }
          return true;
        }
        ctx.claimsHeld = undefined;
        // admit = reserve, still under the lock — the claim→spawn→open
        // window is then visible to the next loop's count. A full
        // stack admits nothing this pass, so it reserves nothing —
        // the listing above still served the hold line
        if (!stackFull && resDir !== null) {
          ceilingRes = reserveCeilingSlot(ctx, resDir);
          if (ceilingRes === null) {
            if (!ctx.claimsHeld) {
              ctx.claimsHeld = { open: -1, max: ctx.cfg.maxOpenTotal };
              ctx.deps.say(
                `loop: claims held — ceiling reservation unwritable/${ctx.cfg.maxOpenTotal}`
              );
            }
            return true;
          }
        }
        return false;
      };
      if (fleetCommon !== null) {
        try {
          withFileLock(join(fleetCommon, 'bro', 'loop.ceiling.lock'), () => {
            held = doCeilCheck();
          });
        } catch {
          held = doCeilCheck();
        }
      } else {
        held = doCeilCheck();
      }
      if (held) {
        // drain beats the hold — an empty queue behind the ceiling has
        // nothing to wait for (same rule as the disk floor)
        if (queueDrained(ctx, ctx.q.seen)) {
          ctx.q.drained = true;
        }
        return false;
      }
    } catch {
      // a listing that can't be produced holds too (fail closed)
      if (!ctx.claimsHeld) {
        ctx.claimsHeld = { open: -1, max: ctx.cfg.maxOpenTotal };
        ctx.deps.say(`loop: claims held — ceiling unknown/${ctx.cfg.maxOpenTotal}`);
      }
      return false;
    }
  } else {
    ctx.claimsHeld = undefined;
  }
  if (stackFull) {
    return false;
  }
  // the disk floor — admission, not eviction. A breached floor holds
  // pushes exactly like a full fleet does: nothing claimed, nothing
  // parked, gate service continues while merges free the disk (spec
  // bro-2spp7). The check sits between the cheap counters and
  // claimClump's store reads so a held push costs one statfs per tick.
  const breach = diskFloorBreach(diskProbes(ctx, ctx.q.diskProbeWarned), ctx.cfg);
  if (breach !== undefined) {
    releaseCeilingFile(ceilingRes);
    return holdForDisk(ctx, breach);
  }
  if (ctx.q.diskHeld) {
    ctx.q.diskHeld = false;
    ctx.deps.say('loop: disk back above floor — pushes resume');
  }
  ctx.stage = 'claim';
  ctx.bead = undefined;
  let clump: ReadyBead[] | undefined;
  try {
    clump = loopPolicy.select(ctx);
  } catch (err) {
    // a wedged task store surfaces HERE — `bd ready`/`bd update --claim`
    // rethrow by design ("a bd outage must surface", next.ts) — as a
    // held push, never a dead supervisor (bro-cu3q8)
    releaseCeilingFile(ceilingRes);
    return holdForInfra(ctx, 'claim', err);
  }
  if (clump === undefined) {
    releaseCeilingFile(ceilingRes);
    ctx.q.drained = true;
    return false;
  }
  const ids = clump.map(b => b.id);
  for (const b of clump) {
    ctx.q.seen.add(b.id);
  }
  ctx.q.claimed += clump.length;
  ctx.bead = clump[0]!.id;
  let out: PushOutcome;
  try {
    out = await pushItem(ctx, clump);
  } catch (err) {
    // a throw past pushItem's own settle arms still owes the claims a
    // release — the same settle its worktree/prompt arms run — then the
    // clump un-sees so the held retry re-picks it (bro-cu3q8)
    releaseCeilingFile(ceilingRes);
    const msg = err instanceof Error ? err.message : String(err);
    const ours = ctx.deps.agents === undefined ? clump : clump.slice(1);
    for (const b of openBeads(ctx, ours)) {
      noteBead(ctx, b.id, `loop: push failed — ${msg}`);
      reopenBead(ctx, b.id);
    }
    ctx.deps.endRun(loopSlug(clump[0]!.id));
    unseeClump(ctx, clump);
    return holdForInfra(ctx, 'push', err);
  }
  if (out.kind === 'hold') {
    // fleet cap or a provider wall refused the spawn — the ceiling
    // reservation goes back (no member will ever list for it), the
    // clump is un-seen, and pushes hold (the wall's reset when one was
    // reported) so the next pick doesn't burn the tick re-probing the
    // same wall; the claims pushItem released are re-pickable
    releaseCeilingFile(ceilingRes);
    unseeClump(ctx, clump, out.untilMs);
    return false;
  }
  if (out.kind === 'infra') {
    // the spawn's own backend wedged — claimStep's store refused on an
    // outage, not a race. The same hold the claim boundary runs:
    // un-see, hold an interval, retry (spec bro-cu3q8)
    releaseCeilingFile(ceilingRes);
    unseeClump(ctx, clump);
    return holdForInfra(ctx, 'claim', out.why);
  }
  if (out.kind === 'member') {
    if (ceilingRes !== null) {
      // the reservation lives until the member's PR lists (swept then)
      // or the member leaves the stack without one
      stampCeilingReservation(ceilingRes, out.member.item.branch);
      ctx.q.ceilingRes.set(out.member.item.branch, ceilingRes);
      ceilingRes = null;
    }
  } else {
    // parked/failed — no PR will ever list for this admission
    releaseCeilingFile(ceilingRes);
  }
  await recordClaimOutcome(ctx, ids, out);
  return true;
}

/** The post-push bookkeeping half of tryClaim — stack the fresh member
 *  or tally the non-member result (parked ids stay drain-visible). */

async function recordClaimOutcome(
  ctx: LoopCtx,
  ids: string[],
  out: Exclude<PushOutcome, { kind: 'hold' } | { kind: 'infra' }>
): Promise<void> {
  if (out.kind === 'member') {
    ctx.q.stack.push(out.member);
    // a worker-pending member reports its pending phase — its `→ PR`
    // line lands when the worker exits and the gate join happens
    ctx.deps.say(pushLine(ctx, out.member.pr, ids, ctx.q.stack.length));
    return;
  }
  await settleOutcome(ctx, ids, out);
}

/** The held-push branch of a tick — park the next probe for an
 *  interval, announce the hold once. The drain verdict is still owed:
 *  claimClump is unreachable under a breach, so without a read-only
 *  check an empty queue behind the floor would retry the floor
 *  forever instead of reporting done. */

function holdForDisk(ctx: LoopCtx, breach: DiskProbe): false {
  // drain beats the hold: an empty queue behind the floor has nothing
  // to wait for — without this check the return below keeps ctx.q.drained
  // unset and the run idles on disk forever
  if (queueDrained(ctx, ctx.q.seen)) {
    ctx.q.drained = true;
    return false;
  }
  ctx.q.pushHoldUntil = ctx.deps.now() + ctx.intervalS * 1000;
  if (!ctx.q.diskHeld) {
    ctx.q.diskHeld = true;
    ctx.deps.say(
      `loop: disk below floor on ${breach.path} — ` +
        `${Math.floor(breach.freeBytes / MB)}M free < ` +
        `${ctx.cfg.diskMinSlots}×${ctx.cfg.worktreeMb}M — pushes held`
    );
  }
  return false;
}

/** Undo a claim attempt the fleet cap refused — the clump goes back to
 *  pickable and pushes hold for a beat. A provider wall's `untilMs`
 *  overrides the beat: the hold IS the wait — re-claiming before the
 *  reset only churns the claim store against a known wall. */

function unseeClump(ctx: LoopCtx, clump: ReadyBead[], untilMs?: number): void {
  for (const b of clump) {
    ctx.q.seen.delete(b.id);
  }
  ctx.q.claimed -= clump.length;
  ctx.q.pushHoldUntil = untilMs ?? ctx.deps.now() + ctx.intervalS * 1000;
}

/** The infra hold for a claim/push that threw on a backend — a wedged
 *  task store, a dead fs, a spawn timeout. A held tick, never a death:
 *  warn once with the retry hint, hold the pick an interval, keep the
 *  run (spec bro-cu3q8). */

function holdForInfra(ctx: LoopCtx, what: string, err: unknown): false {
  ctx.q.pushHoldUntil = ctx.deps.now() + ctx.intervalS * 1000;
  // the (N) counts consecutive held TICKS — runQueue owns the
  // increment on every held tick, so this never bumps infraErrors
  // itself (a double count on the setting tick was bro-cu3q8's review)
  // the stage carries the wait too — the heartbeat and the exit audit
  // classify a wedged backend as infra, never a plain failure. It
  // rides ctx.q.holdStage so the idle overwrite can't erase it mid-hold.
  // (N) reads the pre-increment count — runQueue's renumber lands the
  // +1 for this tick immediately after
  ctx.q.holdStage = `infra hold (${ctx.q.infraErrors}) — ${what}`;
  ctx.stage = ctx.q.holdStage;
  ctx.deps.error(
    `loop: ${what} failed — ${err instanceof Error ? err.message : String(err)} — ` +
      `infra hold; the next interval retries`
  );
  return false;
}

function pushLine(ctx: LoopCtx, pr: number | undefined, ids: string[], gate: number): string {
  return pr === undefined
    ? `loop: ${ids.join(', ')} pushed — worker pending (gate ${gate}/${ctx.cfg.maxOpen})`
    : `loop: ${ids.join(', ')} → PR ${prRef(ctx, pr)} (gate ${gate}/${ctx.cfg.maxOpen})`;
}

/** The round-robin: each tick services the gate stack oldest-first,
 *  then pushes the next bead while a slot is free (loop.maxOpen). The
 *  run ends when the queue is drained or --max claims are spent AND
 *  the stack is empty — pending members wait out their own budgets. */

async function runQueue(ctx: LoopCtx): Promise<void> {
  ctx.q = freshLoopQueue();
  try {
    // sweep a crashed run's records before the first claim — a dead-pid
    // record is residue, not a live worker; live pids are never touched
    ctx.deps.reapRuns();
    // inside the try: a failed scope lookup still owes the run an audit
    const scope = ctx.deps.projectScope();
    if (scope === null || scope === undefined) {
      return;
    }
    ctx.scope = scope;
    for (;;) {
      let busy = false;
      try {
        busy = await servicePass(ctx);
        const claimed = await tryClaim(ctx);
        if (claimed) {
          ctx.q.infraErrors = 0;
          ctx.q.holdStage = undefined;
          continue;
        }
        if (ctx.q.holdStage?.startsWith('infra hold')) {
          ctx.q.infraErrors += 1;
          ctx.q.holdStage = ctx.q.holdStage.includes('(')
            ? ctx.q.holdStage.replace(/\(\d+\)/, `(${ctx.q.infraErrors})`)
            : `infra hold (${ctx.q.infraErrors})`;
          ctx.stage = ctx.q.holdStage;
        } else {
          ctx.q.infraErrors = 0;
          ctx.q.holdStage = undefined;
        }
      } catch (err) {
        ctx.q.infraErrors += 1;
        ctx.q.holdStage = `infra hold (${ctx.q.infraErrors})`;
        ctx.stage = ctx.q.holdStage;
        ctx.deps.error(
          `loop: tick failed (${ctx.q.infraErrors}) — ` +
            `${err instanceof Error ? err.message : String(err)} — ` +
            `infra hold; the next interval retries`
        );
        ctx.q.pushHoldUntil = ctx.deps.now() + ctx.intervalS * 1000;
        await ctx.deps.sleepMs(ctx.intervalS * 1000);
        continue;
      }
      const maxed = ctx.cfg.maxItems > 0 && ctx.q.claimed >= ctx.cfg.maxItems;
      if (ctx.q.stack.length === 0 && (ctx.q.drained || maxed)) {
        break;
      }
      if (!busy) {
        const pending = ctx.q.stack.find(m => m.worker !== undefined);
        const idle =
          ctx.q.holdStage ??
          (ctx.q.wallHeld ? 'idle (wall wait)' : ctx.q.diskHeld ? 'idle (disk floor)' : 'idle');
        ctx.stage =
          pending === undefined
            ? idle
            : `worker ${pending.worker!.agentId} pid=${pending.worker!.pid ?? '?'}`;
        ctx.bead = pending === undefined ? undefined : pending.beads[0]!.id;
        // the wake is the earliest member's own cadence — a worker's
        // WORKER_POLL_MS .exit probe, a gate's interval — still capped
        // by the merge deadline: a member at mergeTimeoutMin must park
        // on the next tick, not an interval late (waitForGate's own
        // sleep was deadline-capped). A worker-pending member has NO
        // merge deadline — its lifetime is unbounded (bro-9lpn3).
        // wall-waiting members are excluded from the merge-deadline
        // term: the wall check short-circuits them before the deadline
        // park, so a deadline that passed DURING the wait would only
        // compute a past wake → ctx.deps.sleepMs(0) → a full fleet reconcile per
        // spin until the reset (coderabbit #728)
        const gated = ctx.q.stack.filter(
          m => m.worker === undefined && m.wallWaitUntil === undefined
        );
        const wake = Math.min(
          ...ctx.q.stack.map(m => m.nextPollAt ?? Number.POSITIVE_INFINITY),
          ...gated.map(m => m.since + ctx.cfg.mergeTimeoutMin * 60_000)
        );
        await ctx.deps.sleepMs(Math.min(ctx.intervalS * 1000, Math.max(0, wake - ctx.deps.now())));
      }
    }
    // the queue is idle — no bead names a settled item in the audit
    ctx.bead = undefined;
    if (ctx.json) {
      ctx.deps.emitJson({ done: true, ...ctx.q.tally });
    } else {
      ctx.deps.out(
        `loop: done — ${ctx.q.tally.landed} landed, ${ctx.q.tally.closed} closed, ${ctx.q.tally.parked} parked, ${ctx.q.tally.failed} failed`
      );
    }
  } finally {
    // idle, gated, or error — the audit always runs; a tail the loop
    // left must surface in the summary, not be discovered later
    ctx.deps.finishAudit();
  }
}

/** Run the queue behind the liveness contract (spec bro-snga4). A
 *  `for(;;)` queue cannot end mid-item — the two silent-death shapes
 *  it must not take: an await that never settles while every live
 *  handle is unref'd (the event loop drains, Node exits 0 mid-run),
 *  and a signal/stray-exit death before the audit.
 *
 *  The heartbeat is the prevention: a ref'd interval holds the event
 *  loop open while a run is live, so a stuck await surfaces as
 *  repeating `loop: alive — <stage>` lines instead of a vanished
 *  process. The death audit is the diagnosis of last resort — any
 *  exit with a run still open prints stage + bead and notes the bead,
 *  exactly what the silent deaths denied. Two shapes it must cover:
 *  'exit' (process.exit / natural end) — where writeSync(2) is the
 *  only write guaranteed to outlive the process — and signals, which
 *  never emit 'exit' and need handlers that audit then re-raise so
 *  the parent still sees the true signal death. */

function runBootstrap(ctx: LoopCtx, beads: ReadyBead[], item: LoopItem): boolean {
  if (!ctx.cfg.bootstrap) {
    return true;
  }
  // operator-configured bootstrap; PATH lookup is the contract (same as git/bd)
  const b = ctx.deps.bootstrap(item.worktreeDir);
  if (b.status === 0) {
    return true;
  }
  for (const bead of openBeads(ctx, beads)) {
    noteBead(
      ctx,
      bead.id,
      `loop: bootstrap failed (${b.status ?? b.signal ?? 'spawn error'}) — worktree kept at ${item.worktreeDir}`
    );
    reopenBead(ctx, bead.id);
  }
  return false;
}

/** The work-order file lives outside the worktree (see planItem) —
 *  its parent dir may not exist yet. Owner-only like the agents-home
 *  prompt (spec bro-l8c4f.4) — the order can embed secrets and thread
 *  context. */
// --- the policy ---------------------------------------------------------------

/** A fresh per-run queue — `run` resets ctx.q with this on every
 *  invocation so a second run on the same ctx starts clean. */
export function freshLoopQueue(): LoopQueue {
  return {
    seen: new Set(),
    stack: [],
    tally: { landed: 0, closed: 0, parked: 0, failed: 0 },
    claimed: 0,
    drained: false,
    parkedClaims: new Set(),
    pushHoldUntil: 0,
    diskHeld: false,
    infraErrors: 0,
    diskProbeWarned: new Set(),
    unclosableNoted: new Set(),
    ceilingRes: new Map(),
    wallHeld: false,
  };
}

/** The loop scheduler as a `Policy<LoopWork, LoopCtx, ServiceVerdict>`.
 *  The four verbs are the lifecycle moments; the drivers below are the
 *  policy's own engine — serviceMember's per-member cadence gate,
 *  servicePass's oldest-first stack sweep + fleet reconcile, tryClaim's
 *  hold ladder + pick + push, and run's supervised queue loop. */
export interface LoopPolicy extends Policy<LoopWork, LoopCtx, ServiceVerdict> {
  /** The push pick — claimClump's candidate→lead→clump decision,
   *  bounded by the run's remaining --max claim budget. The pick IS
   *  the claim: next.ts claimUpTo semantics make pick-and-commit
   *  atomic, so select performs the transition the item enters on.
   *  Throws on a wedged task store — the driver holds and retries. */
  select(ctx: LoopCtx): ReadyBead[] | undefined;
  /** A member's settled PR snapshot → the memberAction dispatch plus
   *  merge finalize — the gate lifecycle moment. */
  onGate(ctx: LoopCtx, item: LoopMember): Promise<ServiceVerdict>;
  /** parkBeads + leave(m,'parked') — every member park's shared row.
   *  `why` is the full park message; `wakeAtMs` snoozes the defer to a
   *  provider reset when one was reported. */
  onPark(ctx: LoopCtx, item: LoopMember, why: string, wakeAtMs?: number): ItemResult;
  /** The worker-'lost' settle — wall wait, retry, park, failed,
   *  closed, or the PR the dead worker opened. */
  onLost(ctx: LoopCtx, item: LoopMember): ServiceVerdict | Promise<ServiceVerdict>;
  /** One member's service tick — wall waits, poll cadence, then the
   *  worker/gate dispatch. */
  serviceMember(ctx: LoopCtx, m: LoopMember): Promise<ServiceVerdict>;
  /** One service pass over the stack, oldest-first, then the orphaned
   *  fleet-PR reconcile. */
  servicePass(ctx: LoopCtx): Promise<boolean>;
  /** The claim half of a tick — holds (push hold, wall wait, ceiling,
   *  stack cap, disk floor) then select → pushItem → outcome row. */
  tryClaim(ctx: LoopCtx): Promise<boolean>;
  /** Claim → worktree → agent → PR-or-settle for one clump. */
  pushItem(ctx: LoopCtx, beads: ReadyBead[]): Promise<PushOutcome>;
  /** The supervised queue loop — service + claim until drained,
   *  then the end-of-run audit. */
  run(ctx: LoopCtx): Promise<void>;
}

export const loopPolicy: LoopPolicy = {
  select(ctx) {
    // --max bounds BEADS, not items — a clump may only fill up to the
    // run's remaining claim budget
    const budget =
      ctx.cfg.maxItems > 0 ? ctx.cfg.maxItems - ctx.q.claimed : Number.MAX_SAFE_INTEGER;
    return claimClump(ctx, ctx.q.seen, budget);
  },
  onGate: serviceGate,
  onPark(ctx, item, why, wakeAtMs) {
    parkBeads(ctx, item.beads, why, wakeAtMs);
    return leave(item, 'parked');
  },
  onLost: serviceLost,
  serviceMember,
  servicePass,
  tryClaim,
  pushItem,
  run: runQueue,
};

/** Drive the loop queue — the command's guardedRun calls this behind
 *  its heartbeat/signal/audit shell. */
export async function runLoop(ctx: LoopCtx): Promise<void> {
  return loopPolicy.run(ctx);
}
