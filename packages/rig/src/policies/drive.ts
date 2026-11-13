/** `drivePolicy` — the drive supervisor as a rig policy (bro-u6fp5.2,
 *  spec bro-u6fp5.2.md). Moved verbatim from `commands/drive.ts` — the
 *  open-fleet-PR watch ran behind one concrete `Ctx`; this slice splits
 *  that context into the policy's own state (`DriveCtx`: config plus
 *  the per-pass `DrivePass` queue/snapshots) and `DriveDeps` — every IO
 *  surface the command owns: the review/tasks facades, the gate-state
 *  cache, the spawn/merge/retire/session planes, enumeration, the
 *  pass ticks (lane usage/pause, litter sweep, projector, pipeline
 *  wake), the alert + foreign-push signals, and the say/error/emitJson
 *  stream. The command keeps argv parsing, config, output routing,
 *  process/signal handling, and the deps wiring; the policy owns the
 *  lifecycle moments the parent spec names:
 *
 *    select  — the pass's service pick: the open-PR set in
 *              enumeration order, dequeued one PR at a time.
 *    onGate  — a PR's settled act-state → the gate.ok merge path
 *              (greenVerdict → mergeAndRetire) or the blocked ladder
 *              (reopened threads, open threads → spawnFixer,
 *              CONFLICTING → spawnRebaseFixer, ci/sast classSpawn) —
 *              every spawn behind the occupancy-locked ceremony.
 *    onPark  — the human-alert settle: publishDriveAlert for every
 *              unmovable verdict and every reviewer-alert — drive's
 *              park IS "a human must look".
 *    onLost  — the settled-fixer sweep: a fixer bead whose PR left the
 *              open set is probed once and closed when the PR settled.
 *
 *  `pass` (one enumeration+service sweep) and `run` (the once-or-
 *  supervised driver) ride along as the policy's own engine — the
 *  same contract convoyPolicy's run/runQueue and loopPolicy's
 *  runQueue set. */
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  type AgentInfo,
  type AgentRegistryEntry,
  type ClaimRow,
  emitLifecycle,
  gitTry,
  type IgnoreCheckRule,
  type PrMeta,
  type CheckInfo,
  type ReviewFacade,
  type ReviewThread,
  readAgentRegistry,
  SpawnError,
  stampPrOwnership,
  type TaskRow,
  type TaskStore,
} from '@broject/core';
import {
  checkHistory,
  evaluateExitGate,
  failingCiChecks,
  fetchPrActState,
  type ExitGate,
  isSast,
  type ListedWatch,
  listWatches,
  liveSastChecks,
  type PrActState,
  type PrStateCache,
  resolveLedger,
  watchEnd,
  watchHeartbeat,
  watchMarkerKind,
} from '@broject/act';
import { LEARN_RETRO_CLOSEOUT } from '@broject/loop';
import { rigNext, type RigNext } from '../next.ts';
import { ensureFixerWorktree } from '../fixer-worktree.ts';
import {
  ensureFixerBead,
  fixerAttemptSpent,
  fixerBeadFor,
  fixerPrFromRef,
  FIXER_LABEL,
  recordFixerAttempt,
} from '../fixer.ts';
import {
  acquireOccupancyLocks,
  freshOccupancy,
  greenOccupancy,
  occupied,
  type OccupancyCtx,
  retireOrphanedWorktree,
  supervisedBy,
  supervisorFresh,
} from '../occupancy.ts';
import { agentProcessesIn, hooksDirOf, liveWorkEntries, type WorkEntry } from '../proc-owner.ts';
import type { Policy } from '../policy.ts';

// --- the split context ---------------------------------------------------------

/** The act gate's own section — the same six knobs loop's LoopActCfg
 *  names, but with the normalized-config shapes: `ignoreChecks` is the
 *  rule list `normalizeActSection` guarantees (strings are folded to
 *  rules at load), and every field is present — the command hands the
 *  whole normalized `act` section straight through. */
export interface DriveActCfg {
  ignoreChecks: IgnoreCheckRule[];
  maxRounds: number;
  docsPaths: string[];
  docsMaxRounds: number;
  requireApproval: boolean;
  approvers: string[];
}

/** The spawn request the locked ceremony hands the command's spawn
 *  plane — the StepSpawnRequest fields the fixer spawn sets, named
 *  structurally so rig never imports the CLI module. */
export interface DriveSpawnRequest {
  lane: 'batch' | 'interactive';
  molStep: string;
  worktree: string;
  prompt: string;
  connector?: string;
  provider?: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
}

/** The pipeline waker's report, narrowed to the fields the pass's say
 *  lines read — the CLI's WakeReport satisfies it structurally. */
export interface DriveWakeReport {
  locked: boolean;
  runs: { runId: string; item: string; action: string; detail?: string }[];
  unreadable?: string[];
}

/** Every IO surface the drive pass touches, injected by the command.
 *  Object deps are the live facades (review host, task store, the
 *  shared gate-state feed); function deps are the command's own
 *  adapters — the spawn/merge/retire/session planes, enumeration,
 *  pass ticks, signals, and the output stream. Nothing here reaches
 *  back into a command module, so the policy stays acyclic. */
export interface DriveDeps {
  /** Review facade bound to the main checkout. */
  rev: ReviewFacade;
  /** The serving tasks backend — fixer beads live on it. */
  store: TaskStore;
  /** The shared gate-state feed — every PR probe reads it so drive's
   *  polls share fetches with loop/watch/act-wait (bro-0tcrl). */
  stateCache: PrStateCache | null;
  /** Human-readable line — stderr under --json, stdout otherwise. */
  say: (msg: string) => void;
  /** Diagnostic line — always stderr. */
  error: (msg: string) => void;
  /** One --json verdict row — console.log(JSON.stringify(row)). */
  emitJson: (row: unknown) => void;
  now: () => number;
  sleepMs: (ms: number) => Promise<void>;
  /** `bro act merge` on the PR — the exitCode-normalized boolean. */
  mergePr: (pr: number) => Promise<boolean>;
  /** Post-merge local retirement — worktree + branch, never throws. */
  retireLanding: (state: PrActState, worktree: string | undefined) => void;
  /** Settle recorded ACP sessions — advisory, return ignored. */
  settleSessions: (opts: { worktree?: string; molSteps?: string[] }) => void;
  /** Shadow-mode judge annotations for the fixer prompt's thread
   *  list — undefined when shadow mode is off or the judge fails.
   *  Mutates `budget.remaining` by the fresh decide() calls paid. */
  shadowNotes: (
    pr: number,
    headSha: string,
    open: ReviewThread[],
    budget: { remaining: number }
  ) => Promise<Map<string, string> | undefined>;
  /** The provider's acp-ness — the donor lookup's provider filter. */
  isAcpProvider: (name: string | undefined) => boolean;
  /** The resolved connector runs provider workers — a donor pins an
   *  ACP provider, which worker-less backends refuse (review #732). */
  connectorAcceptsWorkers: (connector: string | undefined) => boolean;
  /** The registry spawn — spawnStepAgent behind the command's env. */
  spawnAgent: (req: DriveSpawnRequest) => Promise<AgentInfo>;
  /** Every branch that can hold an orphaned PR + the completeness
   *  flag — the enumeration's git half stays command-side. */
  candidateBranches: () => { branches: string[]; complete: boolean };
  /** `git worktree list --porcelain` parsed — null on git failure. */
  worktrees: () => { branch?: string; path: string }[] | null;
  /** The fleet's agent snapshot across connectors — byStep + degraded. */
  collectAgents: () => Promise<{ byStep: Map<string, AgentInfo>; degraded: string[] }>;
  /** Prefetch this project's live ledger claims for the occupancy
   *  rung (bro-izpyk.10) — gathered once per pass, then threaded into
   *  every `occupied`/`freshOccupancy` call so the sync, in-lock
   *  verdicts see the pre-lock snapshot. Absent → marker-only, the
   *  pre-migration read. */
  claims?: () => Promise<ClaimRow[]>;
  /** The shadow judge's per-run decide() budget — fresh each pass. */
  judgeBudget: () => { remaining: number };
  /** The devin lane's telemetry emit — advisory, never stalls. */
  laneUsage: () => Promise<void>;
  /** The wall pause reconcile — freeze/thaw walled providers. */
  lanePause: () => void;
  /** The loop-litter sweep — child-process isolated in production. */
  litterSweep: () => Promise<void>;
  /** The drive-alert moment — a stuck PR or silent reviewer reaches
   *  the human through notify.sinks; keyed per PR+cause. */
  publishAlert: (pr: number, link: string, cause: string, detail?: string) => Promise<void>;
  /** The foreign-push signal — a PR a live session armed moved under
   *  it; the bus reports, never coordinates. */
  signalForeignPush: (pr: number, link: string, head: string | undefined) => Promise<void>;
  /** The fleet-status projector tick — labels ride the freshest
   *  act-state cache; reachability changes are the only lines. */
  projectorTick: () => void;
  /** The event-feed arm — bus subscription + write-point watches,
   *  loop mode only; lazy re-arm inside the tick covers the rest. */
  armProjectorFeed: () => Promise<void>;
  /** The pipeline run-waker pass — journaled runs resume when their
   *  awaited input may have settled. */
  pipelineWake: () => Promise<DriveWakeReport>;
}

/** The policy's own state — config plus the per-pass `DrivePass` the
 *  enumeration rebuilds each sweep. The command's Ctx carries every
 *  field here plus its adapter-owned instances (env, loop config), so
 *  dep impls and the policy read the same object. */
export interface DriveCtx {
  deps: DriveDeps;
  /** The main checkout — every git/registry/lock path roots here. */
  mainRoot: string;
  /** The reviews connector's name — fixer work orders name host-CLI
   *  commands, so prompts must match the backend actually serving
   *  this repo (gh on github, glab api on gitlab). */
  host: string;
  repo: string;
  act: DriveActCfg;
  merge: boolean;
  json: boolean;
  /** The spawn connector override — `--connector`. */
  connector?: string;
  /** Merge-path occupancy TTL in ms (drive.occupancyTtlSec) — the
   *  silence bound that turns a green-occupied PR into an adopted
   *  orphan (bro-ihnlv). */
  occTtlMs: number;
  /** --every interval in seconds — defined only in loop mode, which is
   *  also what turns on watch heartbeats; a --once pass is a report,
   *  not supervision. */
  everySec?: number;
  /** The loop-litter sweep throttle — `lastAt` persists across passes
   *  on the same ctx; 0 means the first pass sweeps. */
  litter: { sweepSec: number; lastAt: number };
  /** The pass's gathered world — rebuilt by `pass` each sweep. */
  work: DrivePass;
}

/** One pass's gathered world — the occupancy/agent/watch snapshots
 *  every PR verdict reads, the judge budget the shadow notes spend,
 *  the head SHAs the pass acted on (the foreign-push signal's new
 *  side — it rides here, not the act-state cache, because half the
 *  verdicts invalidate the cache entry), and the open-PR set with
 *  select's pending queue. */
export interface DrivePass {
  worktreeByBranch: Map<string, string>;
  agents: AgentInfo[];
  workDetails: WorkEntry[];
  /** Live ledger claims on this project — the occupancy rung's
   *  cross-session truth (bro-izpyk.10), gathered beside workDetails
   *  once per pass. */
  claims: ClaimRow[];
  /** Watch-marker snapshot for the supervision plane — a `loop`
   *  heartbeat or `act wait` landing mid-pass is re-read under the
   *  occupancy locks (freshOccupancy), never trusted stale. */
  watches: ListedWatch[];
  /** Fresh decide() calls the pass may still pay for — the shadow
   *  judge's `maxDecisionsPerRun` bound is per run, not per PR. */
  judgeBudget: { remaining: number };
  heads: Map<number, string>;
  /** The pass's open-PR set — sweep + heartbeat consumers read it
   *  after the select loop drains `pending`. */
  prs: Set<number>;
  /** select's queue — the open set in enumeration order. */
  pending: number[];
}

/** A fresh pass world — `pass` overwrites ctx.work with a filled one
 *  each sweep; the empty shape keeps a pre-pass select honest. */
export function freshDrivePass(): DrivePass {
  return {
    worktreeByBranch: new Map(),
    agents: [],
    workDetails: [],
    claims: [],
    watches: [],
    judgeBudget: { remaining: 0 },
    heads: new Map(),
    prs: new Set(),
    pending: [],
  };
}

// --- verdicts + small helpers ---------------------------------------------------

export interface PrVerdict {
  pr: number;
  link: string;
  verdict: string;
  detail?: string;
  /** Advisory-check alerts from the act gate (silent reviewers) —
   *  carried on the verdict so the pass loop can surface them without
   *  re-probing the gate. */
  alerts?: string[];
}

/** Verdicts the driver cannot move itself — the "stuck PR" half of the
 *  bead's drive-alert moment ('reviewer down' rides `alerts` instead).
 *  Transients (occupied/enqueued/spawned/settled/green) never alert:
 *  they resolve on their own cadence. */
const ALERT_VERDICTS = new Set([
  'blocked',
  'spawn-refused',
  'spawn-failed',
  'merge-refused',
  'merge-unverified',
  'probe-failed',
  'no-worktree',
  'error',
]);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Silence duration in a verdict detail — minutes under an hour. */
const silentFor = (ms: number): string =>
  ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`;

function closeFixer(ctx: DriveCtx, id: string, reason: string): void {
  try {
    if (ctx.deps.store.get(id)?.status !== 'closed') {
      ctx.deps.store.close(id, reason);
      emitLifecycle(process.cwd(), {
        kind: 'close',
        bead: id,
        to: 'closed',
        detail: { via: 'drive', reason },
      });
    }
  } catch (err) {
    ctx.deps.error(`drive: could not close fixer bead ${id} — ${errText(err)}`);
  }
}

// --- fixer worktree + prompt ---------------------------------------------------------

/** The base the rebase must land on — the ref, its tip, and what the
 *  fixer has to do about it (bro-by8d3). */
export interface BaseTip {
  /** The ref the fixer rebases onto — `origin/main` for a
   *  remote-tracking ref, `main` for the local branch. */
  ref: string;
  /** Its tip, read after the fetch. */
  sha: string;
  /** The ref lives on a remote: the fixer must fetch it again right
   *  before the rebase. */
  remote: boolean;
  /** The repo has an `origin` remote at all — the PR branch can be
   *  fetched from it. */
  origin: boolean;
}

/** The base's tip, fetched NOW (bro-by8d3). The rebase target is a
 *  fact, not a guess: the repo's remote-tracking refs are as old as the
 *  last fetch anybody in the repo ran, and the drive lane ran none — a
 *  rebase onto that ref lands on a base that has already moved, and the
 *  PR stays CONFLICTING after a whole fixer round (the 2026-11-07
 *  incident: rebased onto 780fc295 while main was at 96fca6d1).
 *
 *  The base is resolved the way git can actually read it: `origin/<base>`
 *  (fetched first), then another remote's tracking ref, then the local
 *  branch. A base that exists nowhere is an error — the caller refuses
 *  the spawn, because a rebase without a target is not a rebase. */
export function fetchBaseTip(dir: string, base: string): { tip?: BaseTip; err?: string } {
  const remotes = remoteList(dir);
  const origin = remotes.includes('origin');
  if (origin) {
    const fetch = gitTry(['-C', dir, 'fetch', 'origin', base, '--quiet']);
    if (
      fetch.code !== 0 &&
      !/couldn't find remote ref|remote ref does not exist|no such ref/i.test(fetch.err)
    ) {
      return { err: fetch.err.trim() || `git fetch origin ${base} failed` };
    }
    const tip = gitTry(['-C', dir, 'rev-parse', '--verify', `origin/${base}`]);
    if (tip.code === 0) {
      return { tip: { ref: `origin/${base}`, sha: tip.out.trim(), remote: true, origin: true } };
    }
  }
  for (const remote of remotes) {
    if (remote === 'origin') {
      continue;
    }
    const tip = gitTry(['-C', dir, 'rev-parse', '--verify', `refs/remotes/${remote}/${base}`]);
    if (tip.code === 0) {
      return { tip: { ref: `${remote}/${base}`, sha: tip.out.trim(), remote: true, origin } };
    }
  }
  const local = gitTry(['-C', dir, 'rev-parse', '--verify', `refs/heads/${base}`]);
  if (local.code === 0) {
    return { tip: { ref: base, sha: local.out.trim(), remote: false, origin } };
  }
  return { err: `no branch or remote-tracking ref named ${base}` };
}

/** The configured remotes, `origin` first. */
function remoteList(dir: string): string[] {
  const names = gitTry(['-C', dir, 'remote'])
    .out.split('\n')
    .map(r => r.trim())
    .filter(r => r !== '');
  return [...names.filter(r => r === 'origin'), ...names.filter(r => r !== 'origin')];
}

/** The fixer's work order — unresolved threads at spawn time (the prompt
 *  tells it to re-fetch; more may land while it works). `judge` carries
 *  the shadow verdict line for a thread — annotation the fixer may
 *  read, never an instruction it must obey. */
export function buildFixerPrompt(opts: {
  pr: number;
  link: string;
  branch: string;
  worktree: string;
  threads: {
    path?: string | null;
    line?: number | null;
    author?: string;
    body?: string;
    judge?: string;
  }[];
}): string {
  const list = opts.threads
    .map(
      t =>
        `- ${t.path ?? ''}:${t.line ?? ''} [${t.author ?? '?'}] ${(t.body ?? '').trim()}` +
        (t.judge !== undefined ? `\n    ${t.judge}` : '')
    )
    .join('\n');
  return [
    `# Review fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    `This PR has ${opts.threads.length} unresolved review thread(s). The live list`,
    `is \`bro act threads ${opts.pr}\` — more may have arrived since this prompt.`,
    '',
    list,
    '',
    'Rules:',
    "- Read skills/act/SKILL.md first — it owns this loop's policy.",
    '- Fix valid findings on this branch; commit and push — the push is the verdict.',
    '- For EVERY thread: fix+push OR reply with reason and resolve, OR explicitly defer to a follow-up bead and resolve. You MUST address all threads before stopping.',
    '- You cannot exit cleanly with unresolved threads and no action taken on them.',
    '- Resolve fixed threads silently; reply + resolve with the reason on reject/defer.',
    '- Defer non-blocking nits (P2/P3) to debt beads — never chase a perfect PR.',
    '- NEVER merge — `bro drive` owns the merge on green.',
    '- Exit when threads are zero or all deferred/resolved with explanation.',
    '',
    LEARN_RETRO_CLOSEOUT,
    '',
  ].join('\n');
}

/** The rebase fixer's work order — the drive twin of the loop's
 *  conflict round (`buildRebasePrompt` in @broject/loop): the gate
 *  reports CONFLICTING, the fixer rebases the PR's branch onto its
 *  declared base and force-pushes. The rebase IS the fix: no thread
 *  work is owed on this spawn.
 *
 *  `baseSha` is the base tip bro fetched right before the spawn
 *  (bro-by8d3). It travels into the work order because the base moves:
 *  a rebase onto a stale tip is a rebase that stays conflicting, and
 *  the PR goes back to CONFLICTING for another round. The order of
 *  operations is fetch → verify the tip → re-check the PR → rebase. */
export function buildRebaseFixerPrompt(opts: {
  pr: number;
  link: string;
  branch: string;
  base: string;
  worktree: string;
  repo: string;
  host: string;
  /** The base bro resolved right before the spawn — the ref, its tip,
   *  and whether it lives on a remote. */
  baseTip: BaseTip;
}): string {
  // the merge-state read names the review host's own CLI — a GitLab
  // repo gets the API call a fixer can actually run (the CI work order
  // branches the same way).
  const gitlab = opts.host === 'gitlab';
  const encRepo = encodeURIComponent(opts.repo);
  const mergeCmd = gitlab
    ? `glab api projects/${encRepo}/merge_requests/${opts.pr}`
    : `gh pr view ${opts.pr} --json mergeable`;
  const mergeField = gitlab ? '`detailed_merge_status`' : '`mergeable`';
  const dissolved = gitlab ? '`mergeable`' : 'MERGEABLE';
  const conflicting = gitlab ? '`conflict`' : 'CONFLICTING';
  const { ref, sha, remote } = opts.baseTip;
  const target = `bro resolved the base to \`${ref}\` and it read \`${sha}\`. That is the base tip you rebase onto: a rebase onto a stale base is a rebase that stays conflicting.`;
  // the remote-tracking ref must be re-read right before the rebase; a
  // local branch cannot move under the fetch, but it can be rewritten by
  // someone else — the same check, the same order
  const verify = remote
    ? [
        '',
        '  Fetch the base AGAIN, immediately before the rebase — `git rev-parse',
        `  ${ref}\` must still read \`${sha}\`. If it moved, the base`,
        `  advanced under you: re-check the PR (\`${mergeCmd}\` — read ${mergeField}).`,
        `  ${dissolved} means the conflict dissolved — STOP`,
        `  and report that; do not rebase. ${conflicting} means rebase onto the new tip.`,
      ].join('\n')
    : [
        '',
        '  This base is a LOCAL branch (there is no remote ref to fetch).',
        `  Before the rebase, \`git rev-parse ${ref}\` must still read \`${sha}\`.`,
        `  If it moved, re-check the PR (\`${mergeCmd}\` — read ${mergeField}).`,
        `  ${dissolved} means the conflict dissolved — STOP and report that;`,
        `  do not rebase. ${conflicting} means rebase onto the new tip.`,
      ].join('\n');
  // the PR branch's own tip — a fetch, when there is a remote to fetch
  // from: commits pushed since this checkout was made are invisible to a
  // stale tip, and the base rebase drops them on the lease push
  const branchFetch = opts.baseTip.origin
    ? [
        `- \`git fetch origin ${opts.branch}\` — the PR branch too:`,
        '  commits pushed since this checkout was made are invisible to a stale',
        `  tip. Fold them in first (\`git rebase origin/${opts.branch}\`) or the`,
        '  base rebase drops them on the lease push.',
      ]
    : [];
  return [
    `# Rebase fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    `This PR has merge conflicts with its base branch \`${opts.base}\`. The rebase`,
    'IS the work — no review-thread fixing is owed on this spawn.',
    '',
    target + verify,
    '',
    ...branchFetch,
    `- \`git rebase ${ref}\` —`,
    '  if a rebase is already in progress here, resolve it instead',
    '  (`git rebase --continue` / `--abort` and restart if the state is too',
    '  tangled).',
    "- Keep this PR's own changes — conflicts are with base-branch work that",
    "  landed since, not with the task. When in doubt, preserve the PR's",
    "  intent over the incoming edit's shape.",
    "- Re-verify after the rebase (build/test as the repo's contract asks),",
    '  then `git push --force-with-lease` — the push is the verdict.',
    '',
    'Rules:',
    '- NEVER merge — `bro drive` owns the merge on green.',
    "- If the conflicts genuinely can't be resolved without redesign, say so",
    '  as your final message — do not leave the rebase half-done.',
    '',
    LEARN_RETRO_CLOSEOUT,
    '',
  ].join('\n');
}

/** Everything the locked spawn ceremony needs — an options bag so the
 *  helper stays under the parameter cap. */
interface FixerSpawn {
  branch: string;
  wt: string;
  fixer: TaskRow | undefined;
  prompt: string;
  /** prefixes the spawned detail so a rebase round reads differently
   *  in the pass log. */
  tag?: string;
  /** Same-head dedup (bro-atb2g) — the head this work order targets and
   *  its blocker class. Recorded on the fixer bead's registry entry at
   *  spawn; a clean-exit attempt on the same (head, class) never gets
   *  an identical replay. Thread fixers stay undeduped: new threads
   *  land on an unmoved head, so replay there is real work. */
  attempt?: { head: string; cls: string };
}

/** Cheap pre-check for the locked dedup inside spawnFixerAgent — a
 *  spent verdict decided up front never pays the worktree checkout.
 *  The authoritative re-check still runs under the spawn locks: only
 *  this drive writes the record (one drive per repo, drive.lock), so
 *  no third party can flip spent → unspent between here and there. */
function fixerSpent(
  ctx: DriveCtx,
  pr: number,
  headSha: string,
  fixer: TaskRow | undefined,
  cls: string
): PrVerdict | undefined {
  if (fixer === undefined) {
    return undefined;
  }
  const entry = readAgentRegistry(ctx.mainRoot)[fixer.id];
  return fixerAttemptSpent(entry, headSha, cls)
    ? {
        pr,
        link: ctx.deps.rev.prLink(ctx.repo, pr),
        verdict: 'fixer-spent',
        detail:
          `${cls} fixer already exited clean on this head — ` + 'a pushed head earns a fresh round',
      }
    : undefined;
}

/** The one verdict ladder (spec bro-oy3k1.6): a parked, foreign-
 *  claimed, dep-gated, or closed fixer bead refuses the spawn — the
 *  registry dedup can't see a 'waiting' label. The gate probe is
 *  skipped: an open PR on this bead is drive's own premise, and a host
 *  call has no business under the occupancy lock. A probe on a rig
 *  with no store answers nothing — the registry dedup stays the net. */
function fixerVerdictRefusal(ctx: DriveCtx, beadId: string): string | undefined {
  let rig: RigNext | undefined;
  try {
    rig = rigNext(ctx.mainRoot, beadId, { gate: false, store: ctx.deps.store });
  } catch {
    // fail closed — an unreadable task store must not read as
    // permission to spawn (the refusal IS the verdict we cannot see)
    return 'rig next → unreadable';
  }
  if (rig.verdict === 'step' || rig.verdict === 'gate') {
    return undefined;
  }
  return `rig next → ${rig.verdict}${rig.detail === undefined ? '' : ` — ${rig.detail}`}`;
}

/** A post-await claims re-read for one decision — the pass snapshot
 *  (ctx.work.claims) predates the awaited probes since, so a ledger-only
 *  claim landing in that window is invisible to a verdict that reuses
 *  it. The in-lock refresh can't go async — this read lands right
 *  before it, narrowing the stale window to the lock wait itself (the
 *  residual the spec accepts: claims write outside the occupancy
 *  locks). A missing dep or a failed read falls back to the pass
 *  snapshot — never `[]`, which would misreport an unreadable claims
 *  plane as an empty one (bro-izpyk.10, PR #1056 review). */
async function claimsRefresh(ctx: DriveCtx): Promise<ClaimRow[]> {
  return ctx.deps.claims === undefined
    ? ctx.work.claims
    : await ctx.deps.claims().catch(() => ctx.work.claims);
}

/** The locked spawn ceremony both fixer kinds share — a last occupancy
 *  read right before the spawn (the gap since the pass-level check
 *  covered the worktree create + state refetch, long enough for another
 *  owner to arm this branch), the fixer bead, then the facade spawn.
 *  Both occupancy locks are held across refresh→probe→spawn (see
 *  acquireOccupancyLocks) so a `bro work enter` or a competing spawn
 *  can't land a claim between — the refresh itself must come after the
 *  acquire, or the lock wait is one more stale-input window. */
async function spawnFixerAgent(ctx: DriveCtx, pr: number, s: FixerSpawn): Promise<PrVerdict> {
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  const known = ctx.work.agents;
  // ledger claims write outside the occupancy locks — re-read after the
  // awaits upstream (thread refetch, meta/check probes, annotation) so a
  // claim landing in that window still vetoes the spawn
  const claims = await claimsRefresh(ctx);
  let release: () => void;
  try {
    release = acquireOccupancyLocks(ctx.mainRoot, s.wt);
  } catch (err) {
    return {
      pr,
      link,
      verdict: 'occupied',
      detail: `occupancy re-check failed — ${errText(err)}`,
    };
  }
  try {
    const fresh = freshOccupancy(ctx.mainRoot, known, claims);
    const occ = occupied({
      agents: fresh.agents,
      fixerBead: s.fixer?.id,
      branch: s.branch,
      worktree: s.wt,
      workDetails: fresh.workDetails,
      claims: fresh.claims,
      scanProc: agentProcessesIn,
      pr,
      watches: fresh.watches,
    });
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ };
    }
    const bead = s.fixer ?? ensureFixerBead(ctx.deps.store, pr, link, s.branch);
    // the pre-spawn entry — dedup verdict AND the prev run's cause:
    // the spawn write below resets `cause`, and recordFixerAttempt
    // must promote the run that just finished by what it was BEFORE
    // this spawn, not after. Read inside the lock so a respawn that
    // landed during the wait can't be mislabeled. The caller may have
    // pre-checked with fixerSpent — same verdict either way.
    const prevEntry = readAgentRegistry(ctx.mainRoot)[bead.id];
    if (s.attempt !== undefined && fixerAttemptSpent(prevEntry, s.attempt.head, s.attempt.cls)) {
      return {
        pr,
        link,
        verdict: 'fixer-spent',
        detail:
          `${s.attempt.cls} fixer already exited clean on this head — ` +
          'a pushed head earns a fresh round',
      };
    }
    const refused = fixerVerdictRefusal(ctx, bead.id);
    if (refused !== undefined) {
      return { pr, link, verdict: 'spawn-refused', detail: refused };
    }
    // donor lookup (spec bro-5qsnr §4): while the coder's session
    // lives, the fix order lands as a follow-up turn in THAT session.
    // The fixer bead's own entry first, then any registry entry whose
    // recorded worktree resolves to the fixer's, carrying an acpSessionId
    // on a configured acp provider.
    const donors: AgentRegistryEntry[] = [];
    const own = readAgentRegistry(ctx.mainRoot)[bead.id];
    if (
      own !== undefined &&
      typeof own.acpSessionId === 'string' &&
      own.acpSessionId !== '' &&
      ctx.deps.isAcpProvider(own.provider)
    ) {
      donors.push(own);
    }
    for (const [molStep, entry] of Object.entries(readAgentRegistry(ctx.mainRoot))) {
      if (molStep === bead.id) continue;
      if (typeof entry.acpSessionId !== 'string' || entry.acpSessionId === '') continue;
      if (!ctx.deps.isAcpProvider(entry.provider)) continue;
      if (typeof entry.worktree !== 'string' || entry.worktree === '') continue;
      try {
        // identity, not spelling: two spellings that reach the same
        // directory through different links are the same worktree —
        // realpath is the truth, resolve() the fallback for a path
        // that no longer exists (same shape as settleAcpSessions)
        const entryResolved = resolve(entry.worktree);
        const wtResolved = resolve(s.wt);
        let entryReal: string;
        try {
          entryReal = realpathSync(entryResolved);
        } catch {
          entryReal = entryResolved;
        }
        let wtReal: string;
        try {
          wtReal = realpathSync(wtResolved);
        } catch {
          wtReal = wtResolved;
        }
        if (entryReal !== wtReal && entryResolved !== wtResolved) continue;
      } catch {
        continue;
      }
      donors.push(entry);
    }
    const donor = donors[0];
    // A donor pins an ACP provider, which resolveSpawnProvider turns
    // into an argv/ACP SpawnWorker. Backends that own their provider
    // session (gascity's city.toml), dispatch remotely (copilot), or
    // never spawn (devin) reject a worker-bearing spawn — so an ACP
    // donor on such a backend would force a config refusal. Drop the
    // donor (fresh spawn, no resume) when the resolved connector cannot
    // run provider workers. (review #732)
    const connectorAcceptsWorkers = ctx.deps.connectorAcceptsWorkers(ctx.connector);
    const useDonor = connectorAcceptsWorkers;
    const spawnProvider = useDonor ? donor?.provider : undefined;
    const spawnResume = useDonor ? donor?.acpSessionId : undefined;
    const spawnPrompt =
      useDonor && donor !== undefined && typeof donor.acpSessionId === 'string'
        ? `${s.prompt}\nSession: ${donor.acpSessionId}\n`
        : s.prompt;
    try {
      const info = await ctx.deps.spawnAgent({
        lane: 'batch',
        molStep: bead.id,
        worktree: s.wt,
        prompt: spawnPrompt,
        connector: ctx.connector,
        provider: spawnProvider,
        resumeSessionId: spawnResume,
        env: { BRO_PR: String(pr), BRO_PR_URL: link },
      });
      if (s.attempt !== undefined) {
        recordFixerAttempt(ctx.mainRoot, bead.id, prevEntry, s.attempt.head, s.attempt.cls);
      }
      const pid = info.pid === undefined ? '' : ` pid ${info.pid}`;
      const tag = s.tag ?? '';
      // the dispatched fixer is about to move this PR (rebase push,
      // resolves, replies) — the feed entry that gated the spawn is
      // obsolete, or the next pass re-triggers off a ≤ttl-old snapshot
      ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
      return { pr, link, verdict: 'spawned', detail: `${tag}${bead.id} → ${info.id}${pid}` };
    } catch (err) {
      return {
        pr,
        link,
        verdict: err instanceof SpawnError ? 'spawn-refused' : 'spawn-failed',
        detail: errText(err),
      };
    }
  } finally {
    release();
  }
}

async function spawnFixer(
  ctx: DriveCtx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined
): Promise<PrVerdict> {
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  const known = ctx.work.agents;
  let wt = worktree;
  let created = false;
  if (wt === undefined) {
    const ensured = ensureFixerWorktree(ctx.mainRoot, state.headRef, {
      // the occupancy snapshot is taken INSIDE the guard — the ensure path
      // invokes it while holding the occupancy locks, so a claim that landed
      // during the lock wait is seen before the branch refresh; a pre-lock
      // snapshot would approve a checkout a live session just took
      guard: dir => {
        const fresh = freshOccupancy(ctx.mainRoot, known, ctx.work.claims);
        return occupied({
          agents: fresh.agents,
          fixerBead: fixer?.id,
          branch: state.headRef,
          worktree: dir,
          workDetails: fresh.workDetails,
          claims: fresh.claims,
          scanProc: agentProcessesIn,
          pr,
          watches: fresh.watches,
        });
      },
      lock: dir => acquireOccupancyLocks(ctx.mainRoot, dir),
    });
    if (ensured.occupied !== undefined) {
      return { pr, link, verdict: 'occupied', detail: ensured.occupied };
    }
    if (ensured.path === undefined) {
      return { pr, link, verdict: 'no-worktree', detail: ensured.err };
    }
    wt = ensured.path;
    created = ensured.created === true;
  }
  // threads may have settled between the gate fetch and now — spawning a
  // fixer on an empty list burns an agent for nothing
  const open = (await ctx.deps.rev.reviewThreads({ repo: ctx.repo, pr })).filter(t => !t.resolved);
  if (open.length === 0) {
    if (created) {
      // re-check occupancy before retiring a dir we just added — another
      // owner could claim it during the thread refetch, and `git
      // worktree remove` on a clean tree deletes even a live cwd. The
      // refresh + check + remove all run inside retireOrphanedWorktree under
      // both occupancy locks: a claimant writes its registry entry +
      // .work marker under the same locks, so a claim lands before the
      // check or after the remove — never between. Ledger claims write
      // outside those locks, so the claims leg re-reads here — a claim
      // written during the refetch await is otherwise invisible to the
      // pass snapshot (bro-izpyk.10)
      const retire = retireOrphanedWorktree(
        ctx.mainRoot,
        pr,
        wt,
        state.headRef,
        fixer?.id,
        known,
        await claimsRefresh(ctx)
      );
      if (retire !== undefined) {
        return { pr, link, verdict: 'occupied', detail: retire };
      }
    }
    // the fresh probe just proved the gate's feed entry stale — drop
    // it so the next pass reads the resolved gate, not the cached one
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'threads-resolved' };
  }
  // shadow-mode judge verdicts annotate the prompt's thread list —
  // journaled and rendered, never applied (the fixer still resolves,
  // replies, and defers by its own reading). Runs BEFORE the occupancy
  // locks: a budget of sequential decide() calls under the locks would
  // hold them past other claimants' lock timeouts. Occupancy is still
  // re-read under the locks immediately before the spawn, so a claim
  // landing during annotation is caught the same way.
  const notes = await ctx.deps.shadowNotes(pr, state.headSha, open, ctx.work.judgeBudget);
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    prompt: buildFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      worktree: wt,
      threads: open.map(t => ({
        path: t.comment?.path,
        line: t.comment?.line,
        author: t.comment?.author,
        body: t.comment?.body,
        judge: notes?.get(t.id),
      })),
    }),
  });
}

/** The conflict fixer — mergeable=CONFLICTING on an orphaned PR gets
 *  the same fixer spawn with a rebase work order (bro-glkes). The
 *  prMeta probe doubles as the still-conflicted re-check: a conflict
 *  that evaporated between the gate fetch and now must not burn a
 *  spawn, and a settled PR never gets a worker. UNKNOWN still counts
 *  as conflicted — the host is recomputing the same state, not
 *  cleared. Runs BEFORE the worktree checkout: a settled conflict
 *  never pays create+retire. */
async function spawnRebaseFixer(
  ctx: DriveCtx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined
): Promise<PrVerdict> {
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  let meta: PrMeta;
  try {
    meta = await metaOf(ctx, pr);
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) };
  }
  if (meta.state !== 'OPEN') {
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'settled', detail: meta.state.toLowerCase() };
  }
  if (meta.mergeable === 'MERGEABLE') {
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'conflict-resolved' };
  }
  const lane = fixerLane(ctx, pr, link, state.headRef, worktree, fixer, meta.headSha, 'rebase');
  if ('verdict' in lane) {
    return lane;
  }
  const wt = lane.wt;
  // a dir this pass added and nobody claimed is litter: every path that
  // ends the pass without handing the worktree to a fixer retires it
  // (the same obligation `spawnFixer` carries on an empty thread list)
  const retireCreated = async (): Promise<void> => {
    if (lane.created !== true) {
      return;
    }
    retireOrphanedWorktree(
      ctx.mainRoot,
      pr,
      wt,
      state.headRef,
      fixer?.id,
      ctx.work.agents,
      // the same post-await re-read spawnFixer runs — a ledger claim
      // landing during the fetch/probe window above vetoes the removal
      await claimsRefresh(ctx)
    );
  };
  // the base tip, fetched NOW (bro-by8d3) — the remote-tracking refs are
  // as old as the last fetch anybody in the repo ran, and the drive lane
  // ran none. A fetch that failed for a real reason refuses the spawn:
  // a rebase onto a known-stale base is a round that ends CONFLICTING.
  const fetched = fetchBaseTip(wt, meta.baseRef);
  if (fetched.tip === undefined) {
    await retireCreated();
    return { pr, link, verdict: 'rebase-base-unavailable', detail: fetched.err };
  }
  let base = meta.baseRef;
  let baseTip = fetched.tip;
  // the PR, re-checked against the tip just fetched: the base may have
  // moved under the fetch, and a conflict that dissolved with it is not
  // work — the pass ends green and drive merges it.
  let after: PrMeta;
  try {
    after = await metaOf(ctx, pr);
  } catch (err) {
    await retireCreated();
    return { pr, link, verdict: 'probe-failed', detail: errText(err) };
  }
  if (after.state !== 'OPEN') {
    await retireCreated();
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'settled', detail: after.state.toLowerCase() };
  }
  if (after.mergeable === 'MERGEABLE') {
    await retireCreated();
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return {
      pr,
      link,
      verdict: 'conflict-resolved',
      detail: `base ${meta.baseRef} moved — ${baseTip.sha.slice(0, 8)}`,
    };
  }
  // the PR was RETARGETED while we fetched: the base we resolved is not
  // the base the PR wants — resolve the new one instead of pairing the
  // old tip with the new name
  if (after.baseRef !== meta.baseRef) {
    const moved = fetchBaseTip(wt, after.baseRef);
    if (moved.tip === undefined) {
      await retireCreated();
      return { pr, link, verdict: 'rebase-base-unavailable', detail: moved.err };
    }
    base = after.baseRef;
    baseTip = moved.tip;
  }
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    prompt: buildRebaseFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      base,
      baseTip,
      worktree: wt,
      repo: ctx.repo,
      host: ctx.host,
    }),
    tag: 'rebase ',
    attempt: { head: meta.headSha, cls: 'rebase' },
  });
}

/** Fresh prMeta for the spawn-path re-probes — the gate's state snapshot
 *  is stale by the time a fixer spawns, so a settle or a moved head
 *  between the two reads is caught here, never assumed away. */
function metaOf(ctx: DriveCtx, pr: number): Promise<PrMeta> {
  const t = { repo: ctx.repo, pr };
  return ctx.deps.rev.prMetaAsync === undefined
    ? Promise.resolve().then(() => ctx.deps.rev.prMeta(t))
    : ctx.deps.rev.prMetaAsync(t);
}

/** The spawn-path re-probe every blocking-class fixer shares: fresh
 *  prMeta + live checks read AFTER the gate snapshot — a settle or a
 *  moved head between the two reads is caught here, never assumed
 *  away (meta.headSha is what dedup + annotation lookups must use). */
async function freshOpen(
  ctx: DriveCtx,
  pr: number
): Promise<{ link: string; meta: PrMeta; checks: CheckInfo[] } | PrVerdict> {
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  let meta: PrMeta;
  let checks: CheckInfo[];
  try {
    [meta, checks] = await Promise.all([metaOf(ctx, pr), checksOf(ctx, pr)]);
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) };
  }
  if (meta.state !== 'OPEN') {
    // the fresh probe just proved the gate's feed entry stale — drop
    // it so the next pass reads the settled gate, not the cached one
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'settled', detail: meta.state.toLowerCase() };
  }
  return { link, meta, checks };
}

/** The shared tail of every fixer spawn — the class attempt spent on
 *  this head → its verdict; no caller-held worktree → the branch
 *  checkout is ensured here (or no-worktree).
 *
 *  The ensure path may move the branch (a fast-forward to the remote
 *  tip), so the occupancy ladder answers FIRST (bro-by8d3): a checkout
 *  a live session owns is never refreshed. The verdict is 'occupied',
 *  never 'no-worktree' — the worktree exists, it belongs to someone
 *  else. */
function fixerLane(
  ctx: DriveCtx,
  pr: number,
  link: string,
  branch: string,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  headSha: string,
  cls: string
): { wt: string; created?: boolean } | PrVerdict {
  const spent = fixerSpent(ctx, pr, headSha, fixer, cls);
  if (spent !== undefined) {
    return spent;
  }
  if (worktree !== undefined) {
    return { wt: worktree };
  }
  const ensured = ensureFixerWorktree(ctx.mainRoot, branch, {
    // same in-lock snapshot rule as spawnFixer — the guard runs under the
    // occupancy locks, so freshOccupancy must be sampled there, not before
    guard: dir => {
      const fresh = freshOccupancy(ctx.mainRoot, ctx.work.agents, ctx.work.claims);
      return occupied({
        agents: fresh.agents,
        fixerBead: fixer?.id,
        branch,
        worktree: dir,
        workDetails: fresh.workDetails,
        claims: fresh.claims,
        scanProc: agentProcessesIn,
        pr,
        watches: fresh.watches,
      });
    },
    lock: dir => acquireOccupancyLocks(ctx.mainRoot, dir),
  });
  if (ensured.occupied !== undefined) {
    return { pr, link, verdict: 'occupied', detail: ensured.occupied };
  }
  if (ensured.path === undefined) {
    return { pr, link, verdict: 'no-worktree', detail: ensured.err };
  }
  return { wt: ensured.path, created: ensured.created === true };
}

// --- ci-fail / sast fixers (bro-atb2g) -----------------------------------------

/** Facade reads that may be sync-only — the same orSync discipline
 *  fetchPrActState uses: defer the sync call through .then so a throw
 *  becomes a rejection the caller's .catch sees. */
function checksOf(ctx: DriveCtx, pr: number): Promise<CheckInfo[]> {
  const t = { repo: ctx.repo, pr };
  return ctx.deps.rev.checksAsync === undefined
    ? Promise.resolve().then(() => ctx.deps.rev.checks(t))
    : ctx.deps.rev.checksAsync(t);
}

function annotationsOf(
  ctx: DriveCtx,
  headSha: string,
  names: ReadonlySet<string>
): Promise<Map<string, number | null>> {
  return ctx.deps.rev.checkAnnotationsAsync === undefined
    ? Promise.resolve().then(() => ctx.deps.rev.checkAnnotations(ctx.repo, headSha, names))
    : ctx.deps.rev.checkAnnotationsAsync(ctx.repo, headSha, names);
}

/** The gate's effective check set — advisory-ignored names dropped the
 *  same way advisoryFilter removes them, so a work order never names a
 *  check the gate didn't count. */
function gatedChecks(ctx: DriveCtx, checks: CheckInfo[]): CheckInfo[] {
  const rules = ctx.act.ignoreChecks;
  if (rules.length === 0) {
    return checks;
  }
  // An explicit rule excludes ANY matching check — SAST names included,
  // matching advisoryFilter's precedence (the fixer must never be sent
  // to repair a scanner the operator declared advisory).
  return checks.filter(c => !rules.some(r => c.name.toLowerCase().includes(r.name.toLowerCase())));
}

/** The ci-fail fixer's work order — the failing check list at spawn
 *  (the prompt tells it to re-read the live list). A SAST-named run is
 *  flagged: its blocking findings are annotations, not log lines. The
 *  inspect commands name the review host's own CLI — `host` is the
 *  reviews connector's name, so a GitLab-backed repo gets `glab api`
 *  lines a fixer can actually run. */
export function buildCiFixerPrompt(opts: {
  pr: number;
  link: string;
  branch: string;
  worktree: string;
  repo: string;
  host: string;
  failing: CheckInfo[];
}): string {
  const gitlab = opts.host === 'gitlab';
  const encRepo = encodeURIComponent(opts.repo);
  const checksCmd = gitlab
    ? `glab api projects/${encRepo}/merge_requests/${opts.pr}/pipelines`
    : `gh pr checks ${opts.pr}`;
  const sastNote = gitlab
    ? " — a SAST check: its findings live in the scanner's report (the job's links), not log lines"
    : ' — a SAST check: its blocking findings are check-run annotations, not log lines';
  const list = opts.failing
    .map(
      c =>
        `- ${c.name}${c.bucket === 'cancel' ? ' (cancelled)' : ''}` +
        (isSast(c.name) ? sastNote : '')
    )
    .join('\n');
  const inspect = gitlab
    ? [
        `- \`glab api projects/${encRepo}/merge_requests/${opts.pr}/pipelines\` —`,
        "  the MR's pipelines; the head pipeline is the live check list.",
        `- \`glab api projects/${encRepo}/pipelines/<pipeline-id>/jobs\` names`,
        '  the failing jobs and their links.',
        `- \`glab api projects/${encRepo}/jobs/<job-id>/trace\` is a job's own`,
        "  failure record — read the failing job's log before touching code.",
      ]
    : [
        `- \`gh pr checks ${opts.pr}\` names the failing runs and their links.`,
        "- `gh run view --log-failed <run-id>` is a run's own failure record —",
        "  read the failing job's log before touching code.",
        `- For a SAST-named run the findings are annotations:`,
        `  \`gh api repos/${opts.repo}/check-runs/<run-id>/annotations\`.`,
      ];
  return [
    `# CI fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    `This PR has ${opts.failing.length} failing check(s) on its head. The live`,
    `list is \`${checksCmd}\` — more may settle or appear while you`,
    'work. Failing at spawn:',
    '',
    list,
    '',
    'Investigate before editing:',
    ...inspect,
    "- Reproduce the failure in this worktree (the repo's build/test",
    '  contract), fix, commit, push — the push is the verdict.',
    '',
    'Rules:',
    '- NEVER merge — `bro drive` owns the merge on green.',
    '- A failure no code change remediates (infra outage, quota, a check a',
    '  human owns) is still a verdict: say so as your final message and stop',
    '  — a clean exit without a push marks this head as attempted, not',
    '  retried.',
    '',
    LEARN_RETRO_CLOSEOUT,
    '',
  ].join('\n');
}

/** The sast fixer's work order — failure-level annotation counts per
 *  check at spawn. `count` null means the run's annotations couldn't be
 *  fetched — reported as unreadable, not as zero findings. */
export function buildSastFixerPrompt(opts: {
  pr: number;
  link: string;
  branch: string;
  worktree: string;
  repo: string;
  host: string;
  headSha: string;
  findings: { name: string; count: number | null }[];
}): string {
  const gitlab = opts.host === 'gitlab';
  const encRepo = encodeURIComponent(opts.repo);
  const list = opts.findings
    .map(
      f =>
        `- ${f.name}: ` +
        (f.count === null
          ? 'annotations unreadable — re-probe or use the dashboard link'
          : `${f.count} finding(s)`)
    )
    .join('\n');
  const inspect = gitlab
    ? [
        'Read the findings before editing — this host has no check-run',
        "  annotations endpoint; the findings are the scanner's report:",
        `- \`glab api projects/${encRepo}/merge_requests/${opts.pr}/pipelines\` —`,
        "  the MR's pipelines; the head pipeline's jobs name the SAST run.",
        `- \`glab api projects/${encRepo}/jobs/<job-id>/trace\` is the job's`,
        '  record; the scanner dashboard the job links to carries findings.',
      ]
    : [
        'Read the findings before editing — they are check-run annotations:',
        `- \`gh api repos/${opts.repo}/commits/${opts.headSha}/check-runs\` names`,
        "  each run's id;",
        `- \`gh api repos/${opts.repo}/check-runs/<run-id>/annotations\` lists`,
        '  path, line, message, level — the failure-level rows are the blockers.',
        "- The scanner's own dashboard (the check's details link) carries the",
        '  same findings.',
      ];
  return [
    `# SAST fixer — ${opts.link}`,
    '',
    `Worktree: ${opts.worktree} (branch \`${opts.branch}\`) — work here, nowhere`,
    'else. If `node_modules` is missing, run the repo install step first.',
    '',
    "This PR's SAST checks carry failure-level annotation(s) on its head —",
    'the gate counts annotations, not conclusions, so a GREEN check can',
    'still block. At spawn:',
    '',
    list,
    '',
    ...inspect,
    '',
    'Rules:',
    '- Fix valid findings on this branch; a false positive goes through the',
    "  scanner's own suppression path the repo already uses — never a",
    '  silent ignore.',
    "- Re-verify per the repo's contract, commit, push — the push is the",
    '  verdict.',
    '- Findings no code change remediates (scanner config a human owns, a',
    '  disputed severity gate) — say so as your final message and stop; a',
    '  clean exit without a push marks this head as attempted, not retried.',
    '- NEVER merge — `bro drive` owns the merge on green.',
    '',
    LEARN_RETRO_CLOSEOUT,
    '',
  ].join('\n');
}

/** The ci-fail fixer — settled-red non-reviewer checks on an orphaned
 *  PR (bro-atb2g). The meta+checks re-probe doubles as the still-open /
 *  still-failing re-check: a PR that settled or a run that went green
 *  between the gate fetch and now must not burn a spawn, and the same
 *  reads name the failing set + live head for the work order. Runs
 *  BEFORE the worktree checkout for the same reason the conflict probe
 *  does. */
async function spawnCiFixer(
  ctx: DriveCtx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined
): Promise<PrVerdict> {
  const fresh = await freshOpen(ctx, pr);
  if ('verdict' in fresh) {
    return fresh;
  }
  const { link, meta, checks } = fresh;
  const failing = failingCiChecks(gatedChecks(ctx, checks));
  if (failing.length === 0) {
    // fresh checks cleared what the cached gate called ci-fail — the
    // feed entry that classified this PR is stale
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'ci-resolved' };
  }
  const lane = fixerLane(ctx, pr, link, state.headRef, worktree, fixer, meta.headSha, 'ci');
  if ('verdict' in lane) {
    return lane;
  }
  const wt = lane.wt;
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    prompt: buildCiFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      worktree: wt,
      repo: ctx.repo,
      host: ctx.host,
      failing,
    }),
    tag: 'ci ',
    attempt: { head: meta.headSha, cls: 'ci' },
  });
}

/** The sast fixer — failure-level annotations on a live SAST check's
 *  head run (bro-atb2g). A green run can carry them: the gate counts
 *  annotations, not conclusions. The meta+checks+annotations re-probe
 *  is the still-open / still-present re-check — a settled PR, a moved
 *  head, or findings fixed between the gate fetch and now must not
 *  burn a spawn (and a moved head's annotations are fetched at the
 *  live sha, never the gate's stale one). */
async function spawnSastFixer(
  ctx: DriveCtx,
  pr: number,
  state: PrActState,
  worktree: string | undefined,
  fixer: TaskRow | undefined
): Promise<PrVerdict> {
  const fresh = await freshOpen(ctx, pr);
  if ('verdict' in fresh) {
    return fresh;
  }
  const { link, meta, checks } = fresh;
  const names = liveSastChecks(gatedChecks(ctx, checks)).map(c => c.name);
  if (names.length === 0) {
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'sast-resolved' };
  }
  let annotations: Map<string, number | null>;
  try {
    annotations = await annotationsOf(ctx, meta.headSha, new Set(names));
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) };
  }
  const findings = names
    .map(name => ({ name, count: annotations.get(name) }))
    .filter((f): f is { name: string; count: number | null } => f.count !== undefined);
  // only positive counts spawn — a null (unreadable annotations) is the
  // gate's sast_unknown shape: infra, retried by the next pass's own
  // probe, never an agent's work order
  if (!findings.some(f => f.count !== null && f.count > 0)) {
    ctx.deps.stateCache?.invalidate({ repo: ctx.repo, pr });
    return { pr, link, verdict: 'sast-resolved' };
  }
  const lane = fixerLane(ctx, pr, link, state.headRef, worktree, fixer, meta.headSha, 'sast');
  if ('verdict' in lane) {
    return lane;
  }
  const wt = lane.wt;
  return spawnFixerAgent(ctx, pr, {
    branch: state.headRef,
    wt,
    fixer,
    prompt: buildSastFixerPrompt({
      pr,
      link,
      branch: state.headRef,
      worktree: wt,
      repo: ctx.repo,
      host: ctx.host,
      headSha: meta.headSha,
      // the work order lists the runs that carry (or might carry)
      // findings — clean runs are noise on it
      findings: findings.filter(f => f.count === null || f.count > 0),
    }),
    tag: 'sast ',
    attempt: { head: meta.headSha, cls: 'sast' },
  });
}

/** The merge side of a green gate: `act merge`, then prove the merge
 *  landed — a merge-queue acceptance exits 0 without a landed head, so
 *  only a MERGED re-probe entitles retirement. Anything else keeps the
 *  PR for the next pass instead of retiring its worktree early. */
async function mergeAndRetire(
  ctx: DriveCtx,
  pr: number,
  link: string,
  worktree: string | undefined,
  fixer: TaskRow | undefined,
  note?: string
): Promise<PrVerdict> {
  const d = (base?: string): string | undefined => {
    if (note === undefined) {
      return base;
    }
    if (base === undefined) {
      return note;
    }
    return `${note}; ${base}`;
  };
  if (!(await ctx.deps.mergePr(pr))) {
    return { pr, link, verdict: 'merge-refused', detail: d() };
  }
  const after = await fetchPrActState(
    ctx.deps.rev,
    { repo: ctx.repo, pr },
    {
      ignoreChecks: ctx.act.ignoreChecks,
      checkHistory: checkHistory(ctx.mainRoot),
      maxRounds: ctx.act.maxRounds,
      docsPaths: ctx.act.docsPaths,
      docsMaxRounds: ctx.act.docsMaxRounds,
      requireApproval: ctx.act.requireApproval,
      approvers: ctx.act.approvers,
      resolveLedger: resolveLedger(ctx.mainRoot),
    }
  ).catch(() => undefined);
  // exit-0 + OPEN IS the enqueue contract — act merge exits 0 only on a
  // landed merge or a queue acceptance (every refusal sets exit 1).
  // Parked, never a failure: no retirement, no fixer close; the next
  // pass re-attempts and merge-async resumes the same uuid.
  if (after?.state === 'OPEN') {
    return { pr, link, verdict: 'enqueued', detail: d('a merge queue owns it') };
  }
  if (after?.state !== 'MERGED') {
    return {
      pr,
      link,
      verdict: 'merge-unverified',
      detail: d(
        after === undefined ? 'state re-probe failed' : `state ${after.state.toLowerCase()}`
      ),
    };
  }
  try {
    ctx.deps.settleSessions(worktree ? { worktree } : {});
  } catch {
    // advisory
  }
  ctx.deps.retireLanding(after, worktree);
  if (fixer) {
    closeFixer(ctx, fixer.id, `merged via ${link}`);
  }
  return { pr, link, verdict: 'merged', detail: d() };
}

/** The post-green verdict ladder — everything the non-green branches
 *  need, bundled so the helpers stay under the parameter cap. */
interface BlockedWork {
  pr: number;
  link: string;
  state: PrActState;
  gate: ExitGate;
  occ: string | undefined;
  worktree: string | undefined;
  fixer: TaskRow | undefined;
}

/** One settled-blocker class's remediation attempt — occupied wins
 *  over every spawn and the round cap bounds it. A verdict in
 *  `declines` (dedup-spent or raced-resolved at the re-probe) owes
 *  nothing more on this head — it declines rather than preempt the
 *  next independent class. `undefined` means the class never ran. */
async function classSpawn(
  b: BlockedWork,
  s: {
    capHit: boolean;
    blocked: boolean;
    declines: ReadonlySet<string>;
    spawn: () => Promise<PrVerdict>;
  }
): Promise<{ v: PrVerdict; declined: boolean } | undefined> {
  if (!s.blocked || s.capHit) {
    return undefined;
  }
  if (b.occ !== undefined) {
    return {
      v: { pr: b.pr, link: b.link, verdict: 'occupied', detail: b.occ },
      declined: false,
    };
  }
  const v = await s.spawn();
  return { v, declined: s.declines.has(v.verdict) };
}

/** Non-green verdicts: threads preempt (same order as the loop's
 *  memberAction), then each settled blocker class earns its fixer —
 *  conflicted → rebase, ci-fail → run-log fixer, sast → annotations
 *  fixer (bro-atb2g) — all bounded by the fixRounds cap. Whatever no
 *  class covers (pending checks, draft, UNKNOWN, BEHIND, sast_unknown)
 *  is plain 'blocked'. Extracted so drivePr stays under the
 *  cognitive-complexity cap. */
async function blockedVerdict(ctx: DriveCtx, b: BlockedWork): Promise<PrVerdict> {
  const { pr, link, state, gate, occ, worktree, fixer } = b;
  if (gate.reopened_threads > 0) {
    // A reopened thread was resolved and then commented on again — the
    // earlier resolution was wrong. A fixer would re-resolve it and
    // hide that, so the work parks for the user instead.
    return {
      pr,
      link,
      verdict: 'blocked',
      detail: `${gate.reopened_threads} reopened thread(s) — resolved before, commented on again; the user confirms`,
    };
  }
  if (gate.open_threads > 0) {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ };
    }
    return spawnFixer(ctx, pr, state, worktree, fixer);
  }
  // a conflicted orphan stalls exactly like an open-thread one did
  // before the fixer existed — 'blocked — merge conflicts' used to be
  // logged and skipped forever (bro-glkes). The bound is the act gate's
  // own round cap — reviewed pushes past maxRounds read as plain
  // 'blocked', not another rebase round. The same cap bounds the
  // ci/sast rounds below: every fixer push that gets reviewed spends
  // from it.
  const capHit = state.maxRounds > 0 && state.fixRounds > state.maxRounds;
  if (state.mergeable === 'CONFLICTING') {
    if (occ !== undefined) {
      return { pr, link, verdict: 'occupied', detail: occ };
    }
    if (!capHit) {
      return spawnRebaseFixer(ctx, pr, state, worktree, fixer);
    }
  }
  // settled-red checks on an orphaned PR used to be terminal 'blocked'
  // — the classes below each get a remediation start instead
  // (bro-atb2g). classSpawn owns the shared contract: occupied wins
  // over every spawn, the round cap bounds it, and a class that owes
  // nothing on this head (dedup-spent or resolved at the re-probe)
  // declines so the NEXT independent class still earns its attempt —
  // a spent ci attempt on a head carrying SAST findings must not
  // starve the sast fixer forever.
  const ci = await classSpawn(b, {
    capHit,
    blocked: gate.ci_failing > 0,
    declines: new Set(['fixer-spent', 'ci-resolved']),
    spawn: () => spawnCiFixer(ctx, pr, state, worktree, fixer),
  });
  if (ci !== undefined && !ci.declined) {
    return ci.v;
  }
  const sast = await classSpawn(b, {
    capHit,
    blocked: gate.sast_pending > 0,
    declines: new Set(['fixer-spent', 'sast-resolved']),
    spawn: () => spawnSastFixer(ctx, pr, state, worktree, fixer),
  });
  if (sast !== undefined && !sast.declined) {
    return sast.v;
  }
  // every class declined or was capped — the first decline is the more
  // informative report than a bare 'blocked'
  return ci?.v ?? sast?.v ?? { pr, link, verdict: 'blocked', detail: gate.blockers.join('; ') };
}

/** Ownership marking (spec bro-c650l) — drive stamps what a loop's
 *  discovery can't reach. A draft is the merge=human contract (the
 *  exit gate never lands one) → 'bro-review'. An orphaned, non-draft
 *  PR under a merging drive is 'bro-managed'. Occupied PRs keep their
 *  own plane's claim — a live loop/worker stamps at its discovery —
 *  and a --no-merge drive supervises without claiming the merge. */
function stampDriveOwnership(
  ctx: DriveCtx,
  pr: number,
  state: PrActState,
  occ: string | undefined
): void {
  const t = { repo: ctx.repo, pr };
  if (state.isDraft) {
    stampPrOwnership(
      ctx.deps.rev,
      t,
      {
        ownership: 'review',
        meta: { managed: false, mode: 'drive', run: state.headRef },
      },
      msg => ctx.deps.say(`drive: ${msg}`)
    );
  } else if (occ === undefined && ctx.merge) {
    stampPrOwnership(
      ctx.deps.rev,
      t,
      {
        ownership: 'managed',
        meta: { managed: true, mode: 'drive', run: state.headRef },
      },
      msg => ctx.deps.say(`drive: ${msg}`)
    );
  }
}

/** The adopt detail — names who went quiet plus the freshest provable
 *  silence, so a merged orphan's verdict reads as an adoption, not a
 *  bare 'green'. */
function adoptedDetail(g: { stale?: string; silentMs?: number }): string | undefined {
  if (g.stale === undefined) {
    return undefined;
  }
  const silence =
    g.silentMs === undefined ? ' (no proven activity)' : ` (silent ${silentFor(g.silentMs)})`;
  return `adopted — ${g.stale}${silence}`;
}

/** The gate.ok path — the merge-path TTL (bro-ihnlv): a green PR waits
 *  on a live owner only while it proves activity inside the window —
 *  silence past it is the same orphan class a branch-less PR is, so
 *  drive adopts and merges rather than reporting 'green-occupied'
 *  forever. */
async function greenVerdict(
  ctx: DriveCtx,
  pr: number,
  link: string,
  g: ReturnType<typeof greenOccupancy>,
  worktree: string | undefined,
  fixer: TaskRow | undefined
): Promise<PrVerdict> {
  if (g.fresh !== undefined) {
    return { pr, link, verdict: 'green-occupied', detail: g.fresh };
  }
  const adopted = adoptedDetail(g);
  if (!ctx.merge) {
    return { pr, link, verdict: 'green', detail: adopted };
  }
  // the pass's watch snapshot predates the gate fetch — a supervisor
  // marker published mid-pass (a loop arming its member) must still
  // veto the merge, so supervision is re-read as mergeGreen's last
  // input. The marker plane isn't lock-serialized; a fresh read is
  // the tightest sync point there is. On the adopt path only a FRESH
  // marker vetoes — a stale one is the silence being adopted against.
  const sup = supervisedBy(listWatches(ctx.mainRoot), pr);
  if (sup !== undefined && (adopted === undefined || supervisorFresh(sup, ctx.occTtlMs))) {
    return {
      pr,
      link,
      verdict: 'green-occupied',
      detail: `supervised by ${watchMarkerKind(sup.file, sup.watch)} pid ${sup.watch.pid}`,
    };
  }
  return mergeAndRetire(ctx, pr, link, worktree, fixer, adopted);
}

/** The per-PR gate evaluation — the onGate verb's body (was drivePr):
 *  fetch the act state, record the head the pass acted on, settle a
 *  non-OPEN PR (sessions + fixer close), else evaluate the exit gate —
 *  ok → ownership stamp + greenVerdict, blocked → ownership stamp +
 *  blockedVerdict. Alerts ride the verdict for the pass to surface. */
async function drivePr(ctx: DriveCtx, pr: number): Promise<PrVerdict> {
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  let state: PrActState;
  try {
    state = await fetchPrActState(
      ctx.deps.rev,
      { repo: ctx.repo, pr },
      {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.mainRoot),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
        requireApproval: ctx.act.requireApproval,
        approvers: ctx.act.approvers,
        stateCache: ctx.deps.stateCache,
        resolveLedger: resolveLedger(ctx.mainRoot),
      }
    );
  } catch (err) {
    return { pr, link, verdict: 'probe-failed', detail: errText(err) };
  }
  // the head this pass acted on — the foreign-push signal's new side. It
  // rides the pass work, not the act-state cache: half the verdicts
  // invalidate the cache entry, so a read after the pass would miss the
  // very head the pass saw.
  ctx.work.heads.set(pr, state.headSha);
  const fixer = fixerBeadFor(ctx.deps.store, pr);
  if (state.state !== 'OPEN') {
    try {
      ctx.deps.settleSessions({
        worktree: ctx.work.worktreeByBranch.get(state.headRef),
        molSteps: fixer ? [fixer.id] : undefined,
      });
    } catch {
      // advisory
    }
    if (fixer) {
      closeFixer(ctx, fixer.id, `${link} ${state.state.toLowerCase()} — fixer done`);
    }
    return { pr, link, verdict: 'settled', detail: state.state.toLowerCase() };
  }
  const gate = evaluateExitGate(state, { requireApproval: ctx.act.requireApproval });
  const worktree = ctx.work.worktreeByBranch.get(state.headRef);
  const occCtx: OccupancyCtx = {
    agents: ctx.work.agents,
    fixerBead: fixer?.id,
    branch: state.headRef,
    worktree,
    workDetails: ctx.work.workDetails,
    claims: ctx.work.claims,
    scanProc: agentProcessesIn,
    pr,
    watches: ctx.work.watches,
  };
  const occ = occupied(occCtx);
  const withAlerts = (v: PrVerdict): PrVerdict => {
    if (gate.alerts.length > 0) {
      v.alerts = gate.alerts;
    }
    return v;
  };
  if (gate.ok) {
    const g = greenOccupancy(occCtx, ctx.occTtlMs);
    // an adopted PR is an orphan — the TTL'd verdict, not the raw
    // occupancy read, decides who keeps their claim (bro-ihnlv)
    stampDriveOwnership(ctx, pr, state, g.fresh);
    return withAlerts(await greenVerdict(ctx, pr, link, g, worktree, fixer));
  }
  stampDriveOwnership(ctx, pr, state, occ);
  return withAlerts(
    await blockedVerdict(ctx, {
      pr,
      link,
      state,
      gate,
      occ,
      worktree,
      fixer,
    })
  );
}

/** branch → worktree path across every checkout — over the injected
 *  worktree listing; a failed listing reads as an empty map (the old
 *  gitTry guard's contract). */
function worktreeMap(ctx: DriveCtx): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of ctx.deps.worktrees() ?? []) {
    if (w.branch) {
      map.set(w.branch, w.path);
    }
  }
  return map;
}

/** Open PR numbers across every candidate branch — a failed listing or
 *  lookup on one source is a warning, never a dead pass. `complete` is
 *  false when the branch listing or any lookup failed: the set then
 *  under-counts open PRs, so consumers must not use it to conclude a
 *  PR is gone. */
function openFleetPrs(ctx: DriveCtx): { prs: Set<number>; complete: boolean } {
  const prs = new Set<number>();
  const candidates = ctx.deps.candidateBranches();
  let complete = candidates.complete;
  if (!complete) {
    ctx.deps.say('warning: branch enumeration failed — the open-PR set may under-count');
  }
  for (const branch of candidates.branches) {
    try {
      for (const pr of ctx.deps.rev.prsForBranch(branch)) {
        prs.add(pr);
      }
    } catch (err) {
      complete = false;
      ctx.deps.say(`warning: PR lookup failed for ${branch} — ${errText(err)}`);
    }
  }
  return { prs, complete };
}

/** The onLost verb — the settled-fixer sweep's per-row verdict (was
 *  the sweepSettledFixers loop body): a fixer bead whose PR left the
 *  open set is probed once — `!OPEN` → settle sessions + close the
 *  bead + the settled say line; still-open, already-closed, or a
 *  probe failure → nothing. The worker's claim is lost only when its
 *  PR settled; an unreadable probe stays for the next pass. */
async function fixerLost(ctx: DriveCtx, row: TaskRow): Promise<PrVerdict | undefined> {
  const pr = fixerPrFromRef(row.external_ref);
  if (pr === undefined || row.status === 'closed' || ctx.work.prs.has(pr)) {
    return undefined;
  }
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  try {
    const st = await fetchPrActState(
      ctx.deps.rev,
      { repo: ctx.repo, pr },
      {
        ignoreChecks: ctx.act.ignoreChecks,
        checkHistory: checkHistory(ctx.mainRoot),
        maxRounds: ctx.act.maxRounds,
        docsPaths: ctx.act.docsPaths,
        docsMaxRounds: ctx.act.docsMaxRounds,
        requireApproval: ctx.act.requireApproval,
        approvers: ctx.act.approvers,
        stateCache: ctx.deps.stateCache,
        resolveLedger: resolveLedger(ctx.mainRoot),
      }
    );
    if (st.state !== 'OPEN') {
      try {
        const entry = readAgentRegistry(ctx.mainRoot)[row.id];
        const wt = typeof entry?.worktree === 'string' ? entry.worktree : undefined;
        ctx.deps.settleSessions({
          molSteps: [row.id],
          ...(wt !== undefined ? { worktree: wt } : {}),
        });
      } catch {
        // advisory
      }
      closeFixer(ctx, row.id, `${link} ${st.state.toLowerCase()} — fixer done`);
      ctx.deps.say(`drive ${link} settled (${st.state.toLowerCase()}) — fixer ${row.id} closed`);
    }
  } catch (err) {
    ctx.deps.say(`warning: fixer sweep probe failed for ${link} — ${errText(err)}`);
  }
  return undefined;
}

/** A settled PR drops out of prsForBranch entirely — without this sweep
 *  its fixer bead hangs open forever after the merge/close. */
async function sweepFixers(ctx: DriveCtx): Promise<void> {
  for (const row of ctx.deps.store.list({ labels: [FIXER_LABEL], all: true })) {
    await fixerLost(ctx, row);
  }
}

/** Heartbeat per supervised PR — deterministic name per drive pid, so
 *  each pass rewrites the same marker and a dead drive leaves exactly
 *  the stale-supervision flag the session-start hook reports. The TTL
 *  covers the sweep interval so a live drive's marker can't age out
 *  between passes. Also retires this drive's markers for PRs that left
 *  the open set — a live marker on a merged PR would keep reporting
 *  "watch active". Skipped on an incomplete enumeration: a failed
 *  lookup must not delete the marker of a PR that is still open.
 *  PRs a live foreign marker already supervises (a `loop` heartbeat,
 *  `act wait`, convoy) are excluded both ways — claiming "watch active"
 *  for a PR this drive will skip is a lie, and a stale own-marker on
 *  one would keep saying it. */
function emitWatchHeartbeats(
  ctx: DriveCtx,
  prs: Set<number>,
  supervised: Set<number>,
  complete: boolean
): void {
  for (const pr of prs) {
    if (supervised.has(pr)) {
      continue;
    }
    watchHeartbeat(
      ctx.mainRoot,
      {
        pr,
        link: ctx.deps.rev.prLink(ctx.repo, pr),
        merge: ctx.merge,
        timeoutMin: Math.ceil(ctx.everySec! / 60) + 1,
      },
      'drive'
    );
  }
  if (!complete) {
    return;
  }
  for (const l of listWatches(ctx.mainRoot)) {
    if (
      l.alive &&
      l.watch.pid === process.pid &&
      basename(l.file).endsWith(`-drive-${process.pid}.json`) &&
      (!prs.has(l.watch.pr) || supervised.has(l.watch.pr))
    ) {
      watchEnd(l.file);
    }
  }
}

/** The select verb — dequeue the next open PR in enumeration order;
 *  `undefined` drains the pass. Durable-state reads only: the queue
 *  is the pass's own snapshot, never a wait. */
function selectPr(ctx: DriveCtx): number | undefined {
  return ctx.work.pending.shift();
}

/** The onPark verb — the human-alert settle (was the pass loop's
 *  publishDriveAlert calls): every unmovable verdict and every
 *  reviewer-alert reaches the human through notify.sinks, keyed
 *  per PR+cause so repeats coalesce. Drive's park IS "a human must
 *  look" — the PR waits for the next pass or an operator. */
async function parkAlert(
  ctx: DriveCtx,
  pr: number,
  cause: string,
  detail?: string
): Promise<PrVerdict | undefined> {
  const link = ctx.deps.rev.prLink(ctx.repo, pr);
  await ctx.deps.publishAlert(pr, link, cause, detail);
  return undefined;
}

/** One pass: enumerate, probe every open PR, act per verdict. */
async function pass(ctx: DriveCtx): Promise<void> {
  await ctx.deps.laneUsage();
  ctx.deps.lanePause();
  // the litter sweep (bro-7dgu3) — provably-done trees ride the
  // drive.litterSweepSec cadence throttled across passes; sweeping
  // BEFORE the enumeration means a reaped branch never reaches
  // openFleetPrs and a just-killed daemon ghost stops pinning the
  // pass's occupancy verdicts
  if (ctx.litter.sweepSec > 0 && ctx.deps.now() - ctx.litter.lastAt >= ctx.litter.sweepSec * 1000) {
    ctx.litter.lastAt = ctx.deps.now();
    try {
      await ctx.deps.litterSweep();
    } catch (err) {
      ctx.deps.say(`warning: litter sweep failed — ${errText(err)}`);
    }
  }
  const { byStep, degraded } = await ctx.deps.collectAgents();
  for (const d of degraded) {
    ctx.deps.say(`warning: backend degraded — ${d}`);
  }
  const hooks = hooksDirOf(ctx.mainRoot);
  ctx.work = {
    ...freshDrivePass(),
    worktreeByBranch: worktreeMap(ctx),
    agents: [...byStep.values()],
    workDetails: hooks === null ? [] : liveWorkEntries(hooks),
    // the claims rung's pre-lock snapshot — one list per pass; a failed
    // read degrades to marker-only occupancy, never a failed pass
    claims: ctx.deps.claims === undefined ? [] : await ctx.deps.claims().catch(() => []),
    watches: listWatches(ctx.mainRoot),
    judgeBudget: ctx.deps.judgeBudget(),
    heads: new Map<number, string>(),
  };
  const { prs, complete } = openFleetPrs(ctx);
  ctx.work.prs = prs;
  ctx.work.pending = [...prs];
  if (ctx.everySec !== undefined) {
    const supervised = new Set(
      [...prs].filter(pr => supervisedBy(ctx.work.watches, pr) !== undefined)
    );
    emitWatchHeartbeats(ctx, prs, supervised, complete);
  }
  for (;;) {
    const pr = selectPr(ctx);
    if (pr === undefined) {
      break;
    }
    // a throwing probe on one PR must not kill the pass — in --every
    // mode an unhandled throw would end the driver entirely
    const v: PrVerdict = await drivePr(ctx, pr).catch(err => ({
      // NOSONAR — a pass settles one PR before judging the next
      pr,
      link: ctx.deps.rev.prLink(ctx.repo, pr),
      verdict: 'error',
      detail: errText(err),
    }));
    await ctx.deps.signalForeignPush(pr, ctx.deps.rev.prLink(ctx.repo, pr), ctx.work.heads.get(pr)); // NOSONAR — the pass settles one PR before judging the next
    // the human edge: unmovable verdicts and silent-reviewer alerts —
    // dedup keys make a repeated pass quiet, not absent
    if (ALERT_VERDICTS.has(v.verdict)) {
      await parkAlert(ctx, pr, v.verdict, v.detail); // NOSONAR — sinks deliver serially, dedup order matters
    }
    if ((v.alerts?.length ?? 0) > 0) {
      await parkAlert(ctx, pr, 'reviewer-alert', v.alerts!.join('; ')); // NOSONAR — serial by contract
    }
    if (ctx.json) {
      ctx.deps.emitJson(v);
    } else {
      ctx.deps.say(`drive ${v.link} ${v.verdict}${v.detail === undefined ? '' : ` — ${v.detail}`}`);
    }
  }
  if (prs.size === 0) {
    ctx.deps.say('drive: no open PRs on fleet branches');
  }
  // the projector rides even a failed sweep — a skipped projection is
  // a stale label, exactly the failure this tick exists to kill
  try {
    await sweepFixers(ctx);
  } finally {
    ctx.deps.projectorTick();
  }
  // the pipeline run-waker (bro-v0pvd.3) — journaled runs resume when
  // their awaited input may have settled (customer records, provider
  // walls, fleet capacity, the PR-settle seam, crash residue). Script-
  // first, rides this cadence on the production engine map (.10) and
  // the <runId>.formula.toml sidecar convention. A throwing pass must
  // not kill the driver — same rule as the PR loop above.
  try {
    const wake = await ctx.deps.pipelineWake();
    if (wake.locked) {
      ctx.deps.say('pipeline wake: another pass holds the lock — skipped');
    } else {
      const woken = wake.runs.filter(r => r.action === 'woken').length;
      const failed = wake.runs.filter(r => r.action === 'failed');
      const unreadable = wake.unreadable ?? [];
      if (woken > 0 || failed.length > 0 || unreadable.length > 0) {
        // name the runs/files an operator must look at — a bare count
        // leaves an unreadable journal or a failed resume invisible
        const details = [
          ...failed.map(r => `${r.runId}/${r.item}: ${r.detail ?? 'failed'}`),
          ...unreadable.map(f => `unreadable ${f}`),
        ];
        ctx.deps.say(
          `pipeline wake: ${woken} woken, ${failed.length} failed of ${wake.runs.length} anchor(s)` +
            (details.length > 0 ? ` — ${details.join('; ')}` : '')
        );
      }
    }
  } catch (err) {
    ctx.deps.say(`warning: pipeline wake failed — ${errText(err)}`);
  }
}

/** The once-or-supervised driver (was the runDrive tail): a --once
 *  invocation is a single report pass; --every arms the projector's
 *  event feed, then loops pass → sleep forever — a throwing pass is
 *  reported and the cadence continues, never a dead driver. */
async function runDrivePolicy(ctx: DriveCtx): Promise<void> {
  if (ctx.everySec === undefined) {
    await pass(ctx);
    return;
  }
  // event-triggered re-projection (bro-xmd9l) — LED transitions ride
  // worker/worktree envelopes between passes; the tick stays the
  // backstop + herdr-restart rehydrator
  await ctx.deps.armProjectorFeed();
  for (;;) {
    try {
      await pass(ctx);
    } catch (err) {
      ctx.deps.say(`drive: pass failed — ${errText(err)}`);
    }
    await ctx.deps.sleepMs(ctx.everySec * 1000);
  }
}

// --- the policy ---------------------------------------------------------------

/** The lifecycle item union the Policy verbs narrow — a PR number is
 *  what select/onGate/onPark take; a fixer bead row is what onLost
 *  takes (the sweep's unit of lost work). Callers always pass the
 *  matching arm — the same union-shaped item LoopWork sets. */
export type DriveWork = number | TaskRow;

/** The drive supervisor as a `Policy<DriveWork, DriveCtx, PrVerdict |
 *  undefined>`. The four verbs are the lifecycle moments; `pass`/`run`
 *  are the policy's own drivers — the enumeration+service sweep and
 *  the once-or-supervised loop (the same contract convoyPolicy's
 *  run/runQueue sets). */
export interface DrivePolicy extends Policy<DriveWork, DriveCtx, PrVerdict | undefined> {
  /** The pass's service pick — the next open PR in enumeration
   *  order, `undefined` when the pass drains. */
  select(ctx: DriveCtx): number | undefined;
  /** A PR's settled act-state → the gate.ok merge path or the
   *  blocked fixer ladder — the gate lifecycle moment. */
  onGate(ctx: DriveCtx, pr: number): Promise<PrVerdict>;
  /** The human-alert settle — publishDriveAlert for an unmovable
   *  verdict or a reviewer-alert; `cause` is the alert key's middle,
   *  `detail` its payload tail. */
  onPark(ctx: DriveCtx, pr: number, cause: string, detail?: string): Promise<PrVerdict | undefined>;
  /** The settled-fixer sweep's per-row verdict — a fixer bead whose
   *  PR left the open set is probed and closed when it settled. */
  onLost(ctx: DriveCtx, row: TaskRow): Promise<PrVerdict | undefined>;
  /** One enumeration+service pass — lane ticks, litter sweep,
   *  agent/watch snapshots, open-PR enumeration, per-PR gate service,
   *  fixer sweep, projector + pipeline wake. */
  pass(ctx: DriveCtx): Promise<void>;
  /** The once-or-supervised driver — pass once, or arm the projector
   *  feed and loop pass → sleep under --every. */
  run(ctx: DriveCtx): Promise<void>;
  /** The settled-fixer sweep driver — every fixer bead row through
   *  onLost (exposed for tests and callers that sweep standalone). */
  sweepFixers(ctx: DriveCtx): Promise<void>;
}

export const drivePolicy: DrivePolicy = {
  select: selectPr,
  onGate: drivePr,
  onPark: parkAlert,
  onLost: fixerLost,
  pass,
  run: runDrivePolicy,
  sweepFixers,
};

/** Drive the supervisor — the command's runDrive calls this behind
 *  its lease/lock/signal shell. */
export async function runDrive(ctx: DriveCtx): Promise<void> {
  return drivePolicy.run(ctx);
}
