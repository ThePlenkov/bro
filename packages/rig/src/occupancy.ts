/**
 * Fleet occupancy plane — the verdicts that answer "does a live owner
 * hold this branch/worktree/PR right now?" across every durable
 * artifact: registry entries, session `.work` markers, per-worktree
 * `bro/work` claims, watch markers, and the /proc scan. Moved from
 * `commands/drive.ts` in the fleet-lifecycle extraction (bro-jamp7):
 * these are the engine reads planes and ACP consume without spawning
 * the CLI. The write side (the locked spawn/retire ceremonies that
 * CALL these verdicts) stays in the command layer.
 */
import { statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  acquireAgentRegistryLock,
  acquireFileLock,
  agentRegistryPath,
  emitLifecycle,
  gitTry,
  readAgentRegistry,
  type AgentInfo,
} from '@broject/core';
import { listWatches, watchMarkerKind, type ListedWatch } from '@broject/act';
import {
  agentProcessesIn,
  detailMatches,
  hooksDirOf,
  liveWorkEntries,
  registryEntryState,
  type ProcHit,
  type WorkEntry,
} from './proc-owner.ts';
import {
  claimLockPath,
  worktreeClaimInfo,
  worktreeIdleMs,
  type WorktreeClaimInfo,
} from './worktree-claim.ts';

/** work/bro-x → bro-x; stack/name/3-bro-x → 3-bro-x. */
export function branchSlug(branch: string): string {
  return branch.split('/').pop() ?? branch;
}

export interface OccupancyCtx {
  /** All backends' agents for the pass. */
  agents: AgentInfo[];
  /** The PR's fixer bead, when one exists — its live agent is our own
   *  fixer, reported as such rather than as a foreign occupant. */
  fixerBead?: string;
  branch: string;
  worktree?: string;
  /** Live session-marker detail lines with their activity stamps. */
  workDetails: WorkEntry[];
  /** Injectable /proc scan — tests pass a stub. */
  scanProc?: (worktree: string) => ProcHit[];
  /** Injectable worktree-claim probe — tests pass a stub. */
  scanClaim?: (worktree: string) => WorktreeClaimInfo | undefined;
  /** Injectable worktree-activity probe — the /proc-hit plane's TTL
   *  input (spec bro-ihnlv). Defaults to worktreeIdleMs. */
  treeIdleMs?: (worktree: string) => number;
  /** The PR being judged — the supervision plane keys on it. */
  pr?: number;
  /** Watch-marker snapshot — a live foreign marker is a supervisor
   *  already owning this PR's gate (bro-0aa87). */
  watches?: ListedWatch[];
}

/** A live watch marker from a non-drive watcher (a `loop` heartbeat, an
 *  `act wait`, a convoy supervisor) means the PR's gate already has an
 *  owner — drive exists for UNSUPERVISED PRs, so these are occupants.
 *  Drive-kind markers self-exclude: a second `bro drive` shares the
 *  fixer bead / merge slot machinery instead of starving this pass by
 *  mutual exclusion. */
export function supervisedBy(
  watches: ListedWatch[] | undefined,
  pr: number | undefined
): ListedWatch | undefined {
  if (watches === undefined || pr === undefined) {
    return undefined;
  }
  return watches.find(
    l => l.alive && l.watch.pr === pr && watchMarkerKind(l.file, l.watch) !== 'drive'
  );
}

/** One occupancy proof — the live-owner detail occupied() reports plus
 *  the last proven activity stamp (bro-ihnlv). `activeAtMs` is the
 *  freshest timestamp the plane can prove: an agent's log or spawn
 *  record, a marker's mtime, the worktree's own churn. Undefined means
 *  the plane shows a live claim but no activity — unverifiable, which
 *  the merge path may never trust forever. */
export interface OccProof {
  detail: string;
  activeAtMs?: number;
}

/** An agent's last proven activity — its output log's mtime or the
 *  spawn record's stamp, whichever is fresher. Both ride the registry:
 *  a backend that never names a log still bounds by spawnedAt, and an
 *  append-mode log must not predate a respawn (same pair loop-state's
 *  silentMs reads). */
function agentActivityMs(a: AgentInfo): number | undefined {
  let at: number | undefined;
  if (a.log !== undefined) {
    try {
      at = statSync(a.log).mtimeMs;
    } catch {
      // no log yet — the spawn stamp still applies
    }
  }
  const spawned = a.spawnedAt === undefined ? Number.NaN : Date.parse(a.spawnedAt);
  if (!Number.isNaN(spawned)) {
    at = at === undefined ? spawned : Math.max(at, spawned);
  }
  return at;
}

function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** fixer-plane proof — fixer agents spawn with molStep = the fixer
 *  bead's id, so this match names our own worker, reported as the
 *  fixer, not a foreign occupant. */
function fixerProof(opts: OccupancyCtx, live: AgentInfo[]): OccProof | undefined {
  if (opts.fixerBead === undefined) {
    return undefined;
  }
  const fixer = live.find(a => a.molStep === opts.fixerBead);
  return fixer === undefined
    ? undefined
    : { detail: `fixer agent live on ${opts.fixerBead}`, activeAtMs: agentActivityMs(fixer) };
}

/** supervisor-plane proof — a live foreign watch marker on this PR. */
function supervisorProof(opts: OccupancyCtx): OccProof | undefined {
  const sup = supervisedBy(opts.watches, opts.pr);
  return sup === undefined
    ? undefined
    : {
        detail: `supervised by ${watchMarkerKind(sup.file, sup.watch)} pid ${sup.watch.pid}`,
        activeAtMs: fileMtimeMs(sup.file),
      };
}

/** worktree-plane proofs — a live agent rooted in the tree, then the
 *  tree's own claim marker. */
function* worktreeProofs(opts: OccupancyCtx, live: AgentInfo[]): Generator<OccProof> {
  if (opts.worktree === undefined) {
    return;
  }
  const wt = resolve(opts.worktree);
  const agent = live.find(a => typeof a.worktree === 'string' && resolve(a.worktree) === wt);
  if (agent !== undefined) {
    yield {
      detail: `agent ${agent.id} live in ${basename(opts.worktree)}`,
      activeAtMs: agentActivityMs(agent),
    };
  }
  const claim = (opts.scanClaim ?? worktreeClaimInfo)(opts.worktree);
  if (claim !== undefined) {
    yield {
      detail:
        `worktree ${basename(opts.worktree)} claimed` +
        (claim.detail === '' ? '' : ` by ${claim.detail}`),
      activeAtMs: claim.mtimeMs,
    };
  }
}

/** marker-plane proof — several markers can name the same work; the
 *  freshest stamp is the honest activity bound (a stale marker beside
 *  a fresh one is a live session, not residue). */
function markerProof(opts: OccupancyCtx): OccProof | undefined {
  const slug = branchSlug(opts.branch);
  const detail = opts.workDetails
    .filter(e => detailMatches(e.detail, { branch: opts.branch, slug, worktree: opts.worktree }))
    .reduce<WorkEntry | undefined>(
      (best, e) =>
        best === undefined ||
        (e.mtimeMs ?? Number.NEGATIVE_INFINITY) > (best.mtimeMs ?? Number.NEGATIVE_INFINITY)
          ? e
          : best,
      undefined
    );
  return detail === undefined
    ? undefined
    : { detail: `session armed work on ${detail.detail}`, activeAtMs: detail.mtimeMs };
}

/** /proc-plane proof — a live process is proof of life at scan time,
 *  not of work: the worktree's own churn (index/HEAD/dir mtimes) is
 *  the silence bound, a process parked in an untouched tree is a
 *  stale owner. */
function procProof(opts: OccupancyCtx, now: number): OccProof | undefined {
  if (opts.worktree === undefined || opts.scanProc === undefined) {
    return undefined;
  }
  const hit = opts.scanProc(opts.worktree)[0];
  if (hit === undefined) {
    return undefined;
  }
  const idle = (opts.treeIdleMs ?? worktreeIdleMs)(opts.worktree);
  return {
    detail: `process ${hit.pid} live in ${basename(opts.worktree)}`,
    activeAtMs: Number.isFinite(idle) ? now - idle : undefined,
  };
}

/** The occupancy ladder as lazy proofs — one source for occupied()'s
 *  first-match verdict and the merge path's freshness check. Yields in
 *  the established order (fixer → supervisor → worktree → markers →
 *  /proc); a plane's stat costs only once the ladder reaches it, so a
 *  first-proof read keeps occupied()'s short-circuit. */
export function* occupancyProofs(
  opts: OccupancyCtx,
  now: number = Date.now()
): Generator<OccProof> {
  const live = opts.agents.filter(a => a.state === 'running' || a.state === 'spawned');
  const fixer = fixerProof(opts, live);
  if (fixer !== undefined) {
    yield fixer;
  }
  const sup = supervisorProof(opts);
  if (sup !== undefined) {
    yield sup;
  }
  yield* worktreeProofs(opts, live);
  const detail = markerProof(opts);
  if (detail !== undefined) {
    yield detail;
  }
  const proc = procProof(opts, now);
  if (proc !== undefined) {
    yield proc;
  }
}

/** Why a PR's worktree is owned right now — undefined = orphaned, the
 *  driver's whole reason to exist. A live agent or session ALWAYS wins
 *  the argument: skipped pass, never double-work on one branch. */
export function occupied(opts: OccupancyCtx): string | undefined {
  return occupancyProofs(opts).next().value?.detail;
}

/** The merge-path occupancy verdict (bro-ihnlv): the freshest proof
 *  inside `ttlMs` keeps the PR 'green-occupied' — a live owner lands
 *  its own merge. Every proof stale or unverifiable means the owner is
 *  silent: the PR counts as orphaned (same class as a branch-less one)
 *  and drive adopts it. `stale` reports occupied()'s own verdict so the
 *  adopt detail names who went quiet; `silentMs` is the freshest
 *  provable silence — undefined when nothing could be stamped at all. */
export function greenOccupancy(
  opts: OccupancyCtx,
  ttlMs: number,
  now: number = Date.now()
): { fresh?: string; stale?: string; silentMs?: number } {
  const proofs = [...occupancyProofs(opts, now)];
  if (proofs.length === 0) {
    return {};
  }
  const best = proofs.reduce<OccProof | undefined>(
    (acc, p) =>
      acc === undefined ||
      (p.activeAtMs ?? Number.NEGATIVE_INFINITY) > (acc.activeAtMs ?? Number.NEGATIVE_INFINITY)
        ? p
        : acc,
    undefined
  );
  if (best?.activeAtMs !== undefined && now - best.activeAtMs <= ttlMs) {
    return { fresh: best.detail };
  }
  return {
    stale: proofs[0]?.detail,
    silentMs: best?.activeAtMs === undefined ? undefined : Math.max(0, now - best.activeAtMs),
  };
}

/** A supervisor marker still vetoing a merge must be fresh — a stale
 *  one is the very silence the TTL adopts against, and letting it veto
 *  would resurrect the forever-wait this bound exists to kill
 *  (bro-ihnlv). An unreadable stamp stays conservative: veto once more,
 *  adoption re-judges next pass. */
export function supervisorFresh(
  sup: ListedWatch,
  ttlMs: number,
  now: number = Date.now()
): boolean {
  const at = fileMtimeMs(sup.file);
  return at === undefined || now - at <= ttlMs;
}

/** The agents plane for the in-lock occupancy refresh — a registry
 *  re-read, never conn.list(): a backend liveness probe (a slow
 *  `gc session list` runs ~30s) inside the hold would outlast the 20s
 *  lock wait and time out `bro work enter` stamps and competing spawns
 *  (bro-taq6). The registry is written under the lock we hold, so the
 *  read catches every spawn that landed during the wait. */
export function registryAgents(dir: string): AgentInfo[] {
  const reg = agentRegistryPath(dir);
  const home = reg === null ? null : join(dirname(reg), 'agents');
  return Object.entries(readAgentRegistry(dir)).map(([molStep, e]) => ({
    id: e.agentId,
    spawnedAt: typeof e.spawnedAt === 'string' ? e.spawnedAt : undefined,
    molStep,
    backend: e.backend,
    pid: typeof e.pid === 'number' ? e.pid : undefined,
    state: registryEntryState(home, e),
    worktree: typeof e.worktree === 'string' ? e.worktree : undefined,
    log: typeof e.log === 'string' ? e.log : undefined,
  }));
}

/** The cheap occupancy planes — registry agents, .work markers,
 *  watch markers. `known` is the pass-level agent snapshot: a
 *  'spawned' registry read inherits the pass's real probe verdict when
 *  it's the same agent GENERATION (a lost fixer stays respawn-able); an
 *  entry the pass never saw, a re-minted agentId, or a respawned
 *  same-id entry (a fresh spawnedAt) keeps the conservative live
 *  verdict — the pass's probe measured a dead generation, not this
 *  run (cubic). A thrown registry read (readAgentRegistry rethrows
 *  EACCES/EIO) is degradation, not emptiness — it falls back to the
 *  pass snapshot rather than propagate an 'error' verdict out of the
 *  lock-held section. */
export interface FreshOccupancy {
  agents: AgentInfo[];
  workDetails: WorkEntry[];
  watches: ListedWatch[];
}

export function freshOccupancy(dir: string, known: AgentInfo[]): FreshOccupancy {
  const byStep = new Map(known.map(a => [a.molStep, a]));
  let fresh: AgentInfo[];
  try {
    fresh = registryAgents(dir);
  } catch {
    fresh = known;
  }
  const agents = fresh.map(a => {
    const seen = byStep.get(a.molStep);
    return a.state === 'spawned' &&
      seen !== undefined &&
      seen.id === a.id &&
      seen.spawnedAt !== undefined &&
      seen.spawnedAt === a.spawnedAt
      ? { ...a, state: seen.state }
      : a;
  });
  const hooks = hooksDirOf(dir);
  return {
    agents,
    workDetails: hooks === null ? [] : liveWorkEntries(hooks),
    // listWatches is a cheap local read — a supervisor that stamped its
    // heartbeat while the lock was being waited on is caught here
    watches: listWatches(dir),
  };
}

/** Lock order is registry → claim, everywhere, and the registry lock
 *  is THE shared occupancy lock every claimant plane serializes on
 *  (bro-qry9): a spawning claimant writes its registry entry + agent
 *  .work marker under it, `bro work enter` stamps its claim under it
 *  (then the worktree's own claim lock), and a session's .work arm
 *  writes under it too. Occupancy-check→remove / check→spawn sections
 *  hold BOTH so a claim lands before the probe or after the action —
 *  never between. The spawn path re-acquires the registry lock
 *  re-entrantly, which is why registry must come first. */
export function acquireOccupancyLocks(dir: string, wt: string | undefined): () => void {
  const releaseReg = acquireAgentRegistryLock(dir);
  let releaseClaim: () => void = () => {};
  try {
    const claimLock = wt === undefined ? null : claimLockPath(wt);
    if (claimLock !== null) {
      releaseClaim = acquireFileLock(claimLock, { label: `${basename(wt!)} claim lock` });
    }
  } catch (err) {
    // a thrown claim acquire must not strand the registry lock — a busy
    // worktree would otherwise wedge every agent operation this process
    releaseReg();
    throw err;
  }
  return () => {
    releaseClaim();
    releaseReg();
  };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Remove a just-created fixer worktree iff still orphaned — the
 *  occupancy refresh, probe, and `git worktree remove` all run under
 *  both occupancy locks (see acquireOccupancyLocks). Refreshing inside
 *  the hold matters: the lock wait itself is a window where a claimant
 *  can land a registry entry a pre-lock snapshot would miss. Returns
 *  the occupancy detail when the tree is owned or a lock can't be
 *  taken, undefined when retired. `fixerBeadId` is the PR's fixer bead
 *  when one exists — its live agent reads as ours, not a foreign
 *  occupant. */
export function retireOrphanedWorktree(
  dir: string,
  pr: number,
  wt: string,
  branch: string,
  fixerBeadId: string | undefined,
  known: AgentInfo[]
): string | undefined {
  let release: () => void;
  try {
    release = acquireOccupancyLocks(dir, wt);
  } catch (err) {
    // a lock we can't take is indistinguishable from an active claimer —
    // occupied is always the safe verdict
    return `occupancy re-check failed — ${errText(err)}`;
  }
  try {
    const fresh = freshOccupancy(dir, known);
    const occ = occupied({
      agents: fresh.agents,
      fixerBead: fixerBeadId,
      branch,
      worktree: wt,
      workDetails: fresh.workDetails,
      scanProc: agentProcessesIn,
      pr,
      watches: fresh.watches,
    });
    if (occ !== undefined) {
      return occ;
    }
    // the work evaporated after we checked out — retire the dir we
    // just added or it lingers as an orphaned fixer worktree
    const rm = gitTry(['-C', dir, 'worktree', 'remove', wt]);
    if (rm.code === 0) {
      emitLifecycle(dir, {
        kind: 'worktree',
        to: 'removed',
        detail: { via: 'drive', worktree: wt, branch, reason: 'orphaned' },
      });
    }
    return undefined;
  } finally {
    release();
  }
}
