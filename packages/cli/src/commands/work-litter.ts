import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  acquireAgentRegistryLock,
  acquireFileLock,
  agentRegistryPath,
  emitLifecycle,
  gitTry,
  LockTimeout,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  sessionProject,
  type AgentRegistryEntry,
  type ClaimRow,
  type ReviewFacade,
  type TaskRow,
  type TaskStore,
} from '@broject/core';
import { beadForHead, loopSection, loopSlug } from '@broject/loop';
import { listWatches, type ListedWatch } from '@broject/act';
import { parseStackBranch } from '@broject/stack';
import {
  agentOwner,
  agentProcessesIn,
  detailMatches,
  hooksDirOf,
  LIVE_MARKER_MS,
  liveWorkDetails,
  ownerTag,
  processesRootedIn,
  registryEntryHoldsClaim,
  worktreeClaim,
  worktreeClaimInfo,
  worktreeGitDir,
  worktreeIdleMs,
  type ProcHit,
} from '@broject/rig';
import { collectLoopRuns, type LoopRunView } from './loop-state.ts';
import { cleanupTmpDirs, workerTmpRoots } from './tmp-sweep.ts';
import {
  hasSubmodules,
  isAncestor,
  mainWorktree,
  parseWorktreePorcelain,
  removeMergedWorktree,
  deleteMergedLocalBranch,
  type WorktreeInfo,
} from './work.ts';

// --- litter sweep ---------------------------------------------------------------
//
// Litter worktrees are disposable by design: the bead's status is the
// verdict record (closed = landed or verdict-closed), the worktree just
// the scratch dir it happened in. A completed loop used to audit its
// tails without removing them — orphaned bro--bro-* dirs accumulated,
// and the same tails on work//feat//fix//devin/ branches and detached
// HEADs were invisible to the prefix-scoped candidate filter
// (bro-imvu3). The sweep reaps what is provably done and keeps
// everything else: a dirty tree, a live claimant, an open PR, or an
// unverifiable bead all read as "unmerged work" — litter a human must
// triage by hand.

export interface LitterReap {
  /** worktrees removed — '<path> [<branch>]' ('(detached)' when no
   *  branch attributed; 'would' list under dryRun) */
  reaped: string[];
  /** branches deleted ('would' list under dryRun) */
  branches: string[];
  /** bead claims released — '<id> (<why>)' ('would' list under dryRun) */
  released: string[];
  /** ghost dirs re-registered as worktrees ('would' list under dryRun) */
  repaired: string[];
  /** stale nx daemons signalled — 'nx daemon pid <n> (<worktree>)'
   *  ('would' list under dryRun) */
  killed: string[];
  /** candidates kept — '<path|branch> (<why>)' */
  kept: string[];
  errors: string[];
}

export interface LitterReapOpts {
  /** repo anchor — any worktree of the repo works; every git op pins -C */
  root: string;
  /** the verdict store — loopSlug(id) maps a litter branch onto a row */
  tasks: TaskStore;
  /** review-host evidence — an open PR vetoes, a merged head pins the
   *  branch delete (squash merges make git's own --merged blind).
   *  Undefined skips the pass: closed-bead + clean still reaps and
   *  branches fall back to `branch -d`. */
  rev?: { repo: string; facade: ReviewFacade };
  /** the stack namespace counted as litter — 'stack/' sweeps every
   *  stack's members, 'stack/<name>/' scopes to one run's chain;
   *  undefined = no stack members (loop/* and the label namespaces
   *  sweep either way) */
  stackPrefix?: string;
  /** parked resume-cache cap — newest N clean open-bead trees survive,
   *  extras reap; 0/undefined = uncapped (spec bro-ho09d) */
  parkedKeep?: number;
  /** parked trees idle past this many days reap regardless of the cap;
   *  0/undefined = no age bound */
  parkedTtlDays?: number;
  /** bead ids the caller vouches for — `bro loop` passes the claims it
   *  deliberately parked THIS run (a park is intent, not an orphan):
   *  they skip claim release but their trees still pool. A later sweep
   *  judges them fresh — the loop that parked them is gone by then. */
  keepClaims?: ReadonlySet<string>;
  /** forwarded to reapStaleNxDaemons — 0 means signal-and-go (the
   *  daemon tick: never block the event loop, next sweep reaps);
   *  undefined = the interactive same-pass bound */
  nxKillWaitMs?: number;
  /** This project's live ledger claims, prefetched by the caller
   *  (bro-izpyk.10) — the `sessionOwner` keep-plane unions them with
   *  the .work/.task marker details. Undefined/absent = marker-only,
   *  the pre-migration read. */
  sessionClaims?: ClaimRow[];
  dryRun?: boolean;
  now?: number;
}

/** Branch prefixes whose tail is a human/agent label, not a
 *  deterministic bead slug — `bro work enter` trees, drive fixers, and
 *  ad-hoc heads all land here (bro-imvu3). The bead verdict resolves
 *  them through beadForHead's prefix match plus the store-prefix short
 *  form; a merged PR's headRef is the land proof either way. */
const LITTER_LABEL_PREFIXES = ['work/', 'feat/', 'fix/', 'devin/'] as const;

/** Litter branch → bead slug + namespace kind: 'loop/<slug>' verbatim;
 *  stack members carry '<n>-<slug>' — parseStackBranch validates the
 *  shape; label prefixes carry their tail with `label: true` (the tail
 *  names a bead only by matching, never by contract). */
function litterSlug(
  branch: string,
  stackPrefix?: string
): { slug: string; label: boolean } | undefined {
  if (branch.startsWith('loop/')) {
    return { slug: branch.slice('loop/'.length), label: false };
  }
  if (stackPrefix !== undefined && branch.startsWith(stackPrefix)) {
    const m = parseStackBranch(branch);
    return m === undefined ? undefined : { slug: m.slug, label: false };
  }
  for (const p of LITTER_LABEL_PREFIXES) {
    if (branch.startsWith(p)) {
      const tail = branch.slice(p.length);
      // a '/' tail is a nested ref name (`work/foo/bar`), never a bead
      // slug — loopSlug sanitizes '/' away, so no lookup rung can ever
      // resolve it; not litter-shaped, skip rather than report a
      // permanent 'no bead' keep every sweep
      return tail.includes('/') ? undefined : { slug: tail, label: true };
    }
  }
  return undefined;
}

interface LitterCandidate {
  /** the live linked worktree the litter branch is checked out in —
   *  undefined for a bare branch */
  w?: WorktreeInfo;
  /** the litter branch — '' for a detached worktree no branch tip
   *  could be attributed to (PR evidence and branch retire skip it) */
  branch: string;
  slug: string;
  /** label-namespace tail (work/feat/fix/devin or a detached dir/claim
   *  slug) — bead lookup goes through litterBead's matching ladder,
   *  not the deterministic exact read alone */
  label?: boolean;
}

/** Everything one candidate's verdict and reap need that is not the
 *  candidate itself — shared state read once for the whole sweep. */
interface LitterCtx {
  opts: LitterReapOpts;
  rep: LitterReap;
  main: WorktreeInfo;
  bySlug: Map<string, TaskRow>;
  /** the store's id prefix ('bro', …) — label-namespace short slugs
   *  resolve through the '<prefix>-<slug>' bead-id form; undefined when
   *  the backend can't name one (that rung just skips) */
  prefix?: string;
  /** claim-liveness planes — who owns an in_progress bead's claim
   *  (spec bro-ho09d). Snapshotted once; the release re-reads the
   *  registry inside the lock so a respawn landing during the wait
   *  still wins. */
  claims: {
    /** loop run records — state already liveness-judged by
     *  collectLoopRuns (pid + pidStart) */
    runs: LoopRunView[];
    /** agents.json snapshot — undefined when unreadable, which fails
     *  CLOSED: an unknowable ownership plane answers "live" */
    registry: Record<string, AgentRegistryEntry> | undefined;
    /** `<common>/bro/agents` — .exit death-proof files live here */
    agentsHome: string | null;
    /** live .work/.task marker details — a session claiming the bead */
    sessionDetails: string[];
    /** live ledger claims on this project — the marker leg's
     *  cross-session twin (bro-izpyk.10); `bro work prune` prefetches
     *  `claims.list({project})` once, a failed read just costs the leg */
    sessionClaims: ClaimRow[];
    /** live act-wait markers — a gate-stack member's claim survives its
     *  worker's exit: the loop (or a rearmed wait) still services it.
     *  `bead`/`workdir` are the match keys (bro-ho09d) */
    watches: ListedWatch[];
  };
}

interface PrEvidence {
  /** false when the host lookup threw — the candidate stays, the PR
   *  state is unknowable */
  known: boolean;
  open: boolean;
  /** a merged PR's head — the land proof AND the pin the branch delete
   *  compares against */
  mergedSha?: string;
}

/** Admin debris + the worktree scan → worktree'd candidates. A failed
 *  list kills the sweep (the candidate set would be fiction); a failed
 *  prune only reports — the sweep still applies. Ghost dirs — siblings
 *  with no registration at all — are recovered BEFORE the candidate
 *  list so they re-enter through the normal verdicts. */
function litterCandidates(
  opts: LitterReapOpts,
  rep: LitterReap
): { main: WorktreeInfo; cands: LitterCandidate[] } | undefined {
  const pr = gitTry(['-C', opts.root, 'worktree', 'prune']);
  if (pr.code !== 0) {
    rep.errors.push(`worktree prune failed — ${pr.err || 'git error'}`);
  }
  const first = gitTry(['-C', opts.root, 'worktree', 'list', '--porcelain']);
  if (first.code !== 0) {
    rep.errors.push(`worktree list failed — ${first.err || 'git error'}`);
    return undefined;
  }
  const main = parseWorktreePorcelain(first.out)[0];
  if (main === undefined) {
    rep.errors.push('worktree list returned no main entry');
    return undefined;
  }
  recoverGhosts(opts, main, rep);
  // a recovered ghost is only visible to a fresh listing — re-read
  const wt = gitTry(['-C', opts.root, 'worktree', 'list', '--porcelain']);
  if (wt.code !== 0) {
    rep.errors.push(`worktree list failed — ${wt.err || 'git error'}`);
    return undefined;
  }
  const all = parseWorktreePorcelain(wt.out);
  const cands: LitterCandidate[] = [];
  const onTree = new Set<string>();
  // the main checkout's own branch is never bare litter — a fix/… or
  // feat/… main must not read as a worktree-less candidate
  if (main.branch !== undefined) {
    onTree.add(main.branch);
  }
  // detached HEADs have no branch to name them — the tip→branch index
  // is built lazily on the first one (one for-each-ref per sweep, and
  // only when a detached tree actually exists)
  let tips: Map<string, string[]> | undefined;
  let tipsRead = false;
  const tipIndex = (): Map<string, string[]> | undefined => {
    if (!tipsRead) {
      tipsRead = true;
      tips = litterBranchTips(opts.root, opts.stackPrefix, rep);
    }
    return tips;
  };
  for (const w of all.slice(1)) {
    if (w.prunable !== undefined || !existsSync(w.path)) {
      continue;
    }
    if (w.branch !== undefined) {
      const s = litterSlug(w.branch, opts.stackPrefix);
      if (s === undefined) {
        continue;
      }
      onTree.add(w.branch);
      cands.push({ w, branch: w.branch, slug: s.slug, label: s.label });
      continue;
    }
    if (w.detached !== true) {
      continue;
    }
    // tip attribution: exactly one candidate-eligible branch sitting
    // on this HEAD names the tree — PR evidence and branch retire ride
    // it. Zero or several matches stay unattributed (branch ''): the
    // dir/claim slug alone feeds the bead verdict.
    const tips = tipIndex();
    if (tips === undefined) {
      // the ref listing failed — attribution is off, so an open PR on
      // the branch that WOULD have claimed this tip is invisible to
      // the bead-only verdict. Keep every detached tree until a sweep
      // can attribute honestly; never a silent reap on a failed probe
      rep.kept.push(`${w.path} (tip index unavailable)`);
      continue;
    }
    const atTip = tips.get(w.head) ?? [];
    const attributed = atTip.length === 1 ? atTip[0] : undefined;
    if (attributed !== undefined) {
      const s = litterSlug(attributed, opts.stackPrefix);
      if (s !== undefined) {
        onTree.add(attributed);
        cands.push({ w, branch: attributed, slug: s.slug, label: s.label });
        continue;
      }
    }
    const slug = detachedLitterSlug(w, main, opts.now);
    if (slug === undefined) {
      continue;
    }
    cands.push({ w, branch: '', slug, label: true });
  }
  litterBranches(opts, rep, onTree, cands);
  return { main, cands };
}

/** Local branch tip → candidate-eligible branch names — the detached
 *  HEAD attribution index. Eligibility is the same litterSlug the
 *  candidate loop applies, so an attributed branch can never name a
 *  namespace the sweep wouldn't have swept anyway. Undefined when the
 *  ref listing fails — the error is reported and every detached tree
 *  keeps until attribution works again (fail closed). */
function litterBranchTips(
  root: string,
  stackPrefix: string | undefined,
  rep: LitterReap
): Map<string, string[]> | undefined {
  const res = gitTry([
    '-C',
    root,
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    'refs/heads/',
  ]);
  if (res.code !== 0) {
    rep.errors.push(`branch tip index failed — ${res.err || 'git error'}`);
    return undefined;
  }
  const map = new Map<string, string[]>();
  for (const line of res.out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) {
      continue;
    }
    const branch = line.slice(0, sp);
    if (litterSlug(branch, stackPrefix) === undefined) {
      continue;
    }
    const sha = line.slice(sp + 1).trim();
    const list = map.get(sha) ?? [];
    list.push(branch);
    map.set(sha, list);
  }
  return map;
}

/** A detached worktree's slug — the in-tree claim marker first (the
 *  enter-time record), then the `<main>--<slug>` sibling-dir
 *  convention. Undefined when neither names one: not litter-shaped,
 *  the tree is skipped rather than reported. */
function detachedLitterSlug(w: WorktreeInfo, main: WorktreeInfo, now?: number): string | undefined {
  const claim = worktreeClaim(w.path, now);
  if (claim !== undefined && claim !== '') {
    return claim;
  }
  const prefix = `${basename(main.path)}--`;
  const name = basename(w.path);
  return name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : undefined;
}

/** Ghost sibling dirs — `<main>--*` on disk but absent from `worktree
 *  list`, invisible to git's own prune (bro-ho09d). The sweep never
 *  guesses deletion: a `.git` file pointing into THIS repo's
 *  `worktrees/<name>` admin space is proof of origin — the admin dir is
 *  recreated (gitdir/commondir/HEAD bound to the branch the name
 *  implies) so the dir re-enters the sweep as a normal candidate.
 *  Everything else is kept and reported: a `.git` directory is a
 *  foreign clone, a pointer outside our admin space is foreign, a
 *  missing `.git` is only removal-safe when the dir is empty, and a
 *  ghost with no matching branch is human triage. */
function recoverGhosts(opts: LitterReapOpts, main: WorktreeInfo, rep: LitterReap): void {
  const reg = agentRegistryPath(opts.root);
  const common = reg === null ? null : dirname(dirname(reg));
  if (common === null) {
    return;
  }
  const adminBase = join(common, 'worktrees');
  const parent = dirname(main.path);
  const prefix = `${basename(main.path)}--`;
  const listed = new Set(
    parseWorktreePorcelain(gitTry(['-C', opts.root, 'worktree', 'list', '--porcelain']).out).map(
      w => resolve(w.path)
    )
  );
  let sibs: string[];
  try {
    sibs = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of sibs) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const path = join(parent, name);
    if (listed.has(resolve(path))) {
      continue;
    }
    try {
      if (!statSync(path).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    recoverGhost(opts, path, name.slice(prefix.length), adminBase, rep);
  }
}

function recoverGhost(
  opts: LitterReapOpts,
  path: string,
  slug: string,
  adminBase: string,
  rep: LitterReap
): void {
  const keep = (why: string): void => {
    rep.kept.push(`${path} (ghost — ${why})`);
  };
  const dotgit = join(path, '.git');
  let isDir: boolean | undefined;
  try {
    isDir = statSync(dotgit).isDirectory();
  } catch {
    reapEmptyGhost(opts, path, rep);
    return;
  }
  if (isDir) {
    keep('separate clone');
    return;
  }
  const admin = worktreeGitDir(path);
  if (admin === null || dirname(admin) !== adminBase) {
    keep('foreign .git pointer');
    return;
  }
  if (existsSync(admin)) {
    return; // registered but unlisted — worktree prune/list's business
  }
  const found = ghostBranch(opts.root, slug);
  if (found === undefined) {
    keep('no branch to bind');
    return;
  }
  if ('ambiguous' in found) {
    keep(`ambiguous branch binding — ${found.ambiguous.join(', ')}`);
    return;
  }
  const branch = found.branch;
  if (opts.dryRun === true) {
    rep.repaired.push(`${path} [${branch}]`);
    return;
  }
  // rebuild the admin entry the way `worktree add` would have written
  // it — gitdir ↔ the worktree's own .git pointer, commondir back to
  // the shared dir, HEAD pinned to the branch. `read-tree HEAD` then
  // repopulates the index so status reads honestly (a ghost whose tip
  // moved off its checkout reads dirty — kept, not silently reaped).
  try {
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${dotgit}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`);
  } catch (err) {
    keep(`admin recreate failed — ${err instanceof Error ? err.message : err}`);
    return;
  }
  gitTry(['-C', path, 'read-tree', 'HEAD']);
  rep.repaired.push(`${path} [${branch}]`);
}

/** A ghost with no `.git` at all — the only provably-safe removal is an
 *  empty dir; anything else is kept as unverifiable provenance. */
function reapEmptyGhost(opts: LitterReapOpts, path: string, rep: LitterReap): void {
  let empty = false;
  try {
    empty = readdirSync(path).length === 0;
  } catch {
    // unreadable — keep below
  }
  if (!empty) {
    rep.kept.push(`${path} (ghost — no .git — not provably a worktree)`);
    return;
  }
  if (opts.dryRun !== true) {
    // rmdirSync, not rmSync: it refuses anything that filled in
    // between the check and the call — the guard IS the syscall
    rmdirSync(path);
  }
  rep.reaped.push(`${path} (empty ghost dir)`);
}

/** The branch a recovered ghost binds HEAD to — the naming convention's
 *  own mapping: loop/<slug> first, then the label namespaces
 *  (work/<slug> — a `bro work enter` tail — plus feat//fix//devin/
 *  ad-hoc heads), else the stack member carrying <slug>. The dir name
 *  carries the slug, not the namespace: when several branches claim it
 *  the binding is a guess that can hand the tree the wrong branch's
 *  bead/PR evidence — 'ambiguous' refuses the recovery instead. */
function ghostBranch(
  root: string,
  slug: string
): { branch: string } | { ambiguous: string[] } | undefined {
  const has = (b: string): boolean =>
    gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).code === 0;
  const matches: string[] = [];
  for (const b of [
    `loop/${slug}`,
    `work/${slug}`,
    `feat/${slug}`,
    `fix/${slug}`,
    `devin/${slug}`,
  ]) {
    if (has(b)) {
      matches.push(b);
    }
  }
  const st = gitTry(['-C', root, 'branch', '--list', 'stack/*', '--format=%(refname:short)']);
  if (st.code === 0) {
    for (const b of st.out.split('\n').filter(s => s !== '')) {
      if (parseStackBranch(b)?.slug === slug) {
        matches.push(b);
      }
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  return matches.length === 1 ? { branch: matches[0] } : { ambiguous: matches };
}

/** Bare litter branches — a worktree-less loop/* (or label-namespace
 *  work//feat//fix//devin/) is the same tail class. */
function litterBranches(
  opts: LitterReapOpts,
  rep: LitterReap,
  onTree: Set<string>,
  cands: LitterCandidate[]
): void {
  for (const pat of ['loop/', opts.stackPrefix, ...LITTER_LABEL_PREFIXES]) {
    if (pat === undefined) {
      continue;
    }
    const bl = gitTry([
      '-C',
      opts.root,
      'branch',
      '--list',
      `${pat}*`,
      '--format=%(refname:short)',
    ]);
    if (bl.code !== 0) {
      rep.errors.push(`branch list ${pat}* failed — ${bl.err || 'git error'}`);
      continue;
    }
    for (const b of bl.out.split('\n').filter(s => s !== '' && !onTree.has(s))) {
      const s = litterSlug(b, opts.stackPrefix);
      if (s !== undefined) {
        cands.push({ branch: b, slug: s.slug, label: s.label });
      }
    }
  }
}

/** slug → bead row over the whole store, closed rows included — the
 *  verdict record. An unreachable store leaves nothing provably done. */
function litterBeads(opts: LitterReapOpts, rep: LitterReap): Map<string, TaskRow> | undefined {
  try {
    return new Map(opts.tasks.list({ all: true }).map(r => [loopSlug(r.id), r]));
  } catch (err) {
    rep.errors.push(`bead list failed — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Candidate → bead row. Deterministic namespaces (loop/, stack/)
 *  read the exact slug map — a miss means no bead, full stop. Label
 *  namespaces (work//feat//fix//devin/ and detached dir/claim slugs)
 *  carry a human label, not a bead contract: beadForHead — the
 *  fleet-head reconcile's own matcher — is the ONLY rung, because its
 *  '-'-bounded prefix match already covers the tidy `work/<bead-id>`
 *  exact tail AND refuses ambiguity (two bead owners → undefined =
 *  keep). A raw exact-map shortcut would bypass that check: `work/
 *  <slug>` naming bead B while a shorter bead also prefix-matches
 *  would attribute the tree to B and reap a live owner's work. The
 *  second rung is the same matcher on the '<prefix>-<slug>' short
 *  form (`work/imvu3` → `bro-imvu3`), skipped when the slug already
 *  carries the prefix (that shape matched at rung one or names a
 *  doubled-prefix bead the prefix rung can't reach anyway). */
function litterBead(ctx: LitterCtx, c: LitterCandidate): TaskRow | undefined {
  if (c.label !== true) {
    return ctx.bySlug.get(c.slug);
  }
  const headRef = c.branch === '' ? `x/${c.slug}` : c.branch;
  const direct = beadForHead({ pr: 0, headRef }, ctx.bySlug);
  if (direct !== undefined) {
    return direct;
  }
  const p = ctx.prefix;
  if (p !== undefined && p !== '' && !c.slug.startsWith(`${p}-`)) {
    return beadForHead({ pr: 0, headRef: `x/${p}-${c.slug}` }, ctx.bySlug);
  }
  return undefined;
}

/** Live registry occupants pinning a tree — an agent (a respawned drive
 *  fixer, say) working a closed bead's tree still owns it. Undefined
 *  when the registry is unreadable: readAgentRegistry deliberately
 *  re-throws on corruption (a silent {} lets a reaper orphan live
 *  agents' trees — bro-f6zp), so an unknowable occupancy plane is a
 *  keep verdict, not an empty map. */
function litterOccupants(root: string): Map<string, string> | undefined {
  const occupied = new Map<string, string>();
  try {
    for (const [molStep, e] of Object.entries(readAgentRegistry(root))) {
      const path = typeof e.worktree === 'string' ? resolve(e.worktree) : undefined;
      const live =
        typeof e.pid === 'number' &&
        pidAlive(e.pid, typeof e.pidStart === 'string' ? e.pidStart : undefined);
      if (path !== undefined && live) {
        occupied.set(path, e.agentId || molStep);
      }
    }
    return occupied;
  } catch {
    return undefined;
  }
}

/** An open PR vetoes outright; a merged one is the land proof AND the
 *  head pin the branch delete compares against. A '' branch (unattributed
 *  detached HEAD) has nothing to ask about — known-clean absence, not a
 *  lookup failure. */
function litterPrEvidence(opts: LitterReapOpts, branch: string): PrEvidence {
  const ev: PrEvidence = { known: true, open: false };
  if (branch === '' || opts.rev === undefined) {
    return ev;
  }
  try {
    for (const pr of opts.rev.facade.prsForBranch(branch, 'all')) {
      const meta = opts.rev.facade.prMeta({ repo: opts.rev.repo, pr });
      if (meta.state === 'OPEN') {
        ev.open = true;
      } else if (meta.state === 'MERGED' && ev.mergedSha === undefined) {
        ev.mergedSha = meta.headSha;
      }
    }
  } catch {
    ev.known = false;
  }
  return ev;
}

/** Worktree-side keep reasons, called under the occupancy lock — the
 *  check and the removal must be one section or a claimant pinning the
 *  path after the check loses its live tree (bro-qry9, bro-0fiq). Only
 *  read after the candidate proved done and veto-free; undefined means
 *  the tree is safe to reap. */
function litterTreeVerdict(c: LitterCandidate, ctx: LitterCtx): string | undefined {
  const w = c.w;
  if (w === undefined) {
    return undefined;
  }
  if (w.locked !== undefined) {
    return w.locked === '' ? 'locked' : `locked (${w.locked})`;
  }
  const occupied = litterOccupants(ctx.opts.root);
  if (occupied === undefined) {
    return 'agent registry unreadable';
  }
  const occupant = occupied.get(resolve(w.path));
  if (occupant !== undefined) {
    return `agent ${occupant} live`;
  }
  if (worktreeClaim(w.path, ctx.opts.now) !== undefined) {
    return 'claimed';
  }
  // the ledger twin of that in-tree claim file (bro-izpyk.10): a live
  // `worktree:`/`branch:` lease on this tree or its branch is the same
  // keep, machine-wide — it survives the session rotating off the box
  const ledgerClaim = sessionClaimOn(ctx.claims.sessionClaims, c);
  if (ledgerClaim !== undefined) {
    return `session ${ledgerClaim.sid.slice(0, 8)} claims ${ledgerClaim.resource}`;
  }
  // the same cleanliness bar removeMergedWorktree enforces, read ahead
  // so kept candidates report a reason
  const st = gitTry(['-c', 'status.showUntrackedFiles=all', '-C', w.path, 'status', '--porcelain']);
  if (st.code !== 0) {
    return 'cleanliness unverifiable';
  }
  if (st.out.trim() !== '') {
    return 'dirty';
  }
  // '' branch = unattributed detached HEAD — the tree's own HEAD is the
  // commits' only ref, and `worktree remove` drops the admin dir that
  // holds it: commits no other ref reaches become gc fodder. The bead
  // verdict proved the WORK done, not that THIS tip landed anywhere —
  // keep unless some ref still holds it (attributed trees and branches
  // are covered by their own ref + the branch-retire guards)
  if (c.branch === '' && !detachedTipReachable(ctx.opts.root, w.path)) {
    return 'detached HEAD unreachable — no ref keeps its commits';
  }
  return undefined;
}

/** Does any ref still reach this tree's HEAD? An unattributed detached
 *  worktree's own HEAD is not a ref — once the worktree is removed,
 *  commits nothing else names are unreachable and gc fodder. Fail
 *  closed: an unverifiable probe keeps the tree. */
function detachedTipReachable(root: string, wtPath: string): boolean {
  const head = gitTry(['-C', wtPath, 'rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) {
    return false;
  }
  const refs = gitTry([
    '-C',
    root,
    'for-each-ref',
    '--contains',
    head.out.trim(),
    '--format=%(refname)',
  ]);
  return refs.code === 0 && refs.out.trim() !== '';
}

/** The evidence-plane keep reason — bead verdict + PR state. undefined
 *  means provably done (the bead closed — the loop's land/verdict
 *  record — or a merged PR names the branch; either proves the work
 *  left) and veto-free; the tree plane is judged separately, under the
 *  occupancy lock. */
function litterDoneVerdict(c: LitterCandidate, ctx: LitterCtx, pr: PrEvidence): string | undefined {
  const bead = litterBead(ctx, c);
  if (bead?.status !== 'closed' && pr.mergedSha === undefined) {
    return bead === undefined ? 'no bead — unverifiable' : `bead ${bead.status ?? 'open'}`;
  }
  if (!pr.known) {
    return 'PR lookup failed';
  }
  if (pr.open) {
    return 'open PR — unmerged';
  }
  return undefined;
}

/** Branch-side retire — a removed/absent worktree frees the branch, so
 *  reaching this code means it is never checked out. A merged PR's head
 *  pins the delete (a squash merge makes git's own --merged blind; only
 *  the host knows the landing). A closed-bead verdict with no merged PR
 *  in reach falls back to git's own merged check: `branch -d` refuses a
 *  tip holding commits past the checked-out base — unlanded work keeps
 *  its branch, whatever the bead says. */
function retireLitterBranch(c: LitterCandidate, ctx: LitterCtx, pr: PrEvidence): void {
  const { opts, rep } = ctx;
  // '' = unattributed detached HEAD — there is no branch to retire
  if (c.branch === '') {
    return;
  }
  if (opts.dryRun === true) {
    rep.branches.push(c.branch);
    return;
  }
  if (pr.mergedSha === undefined) {
    const del = gitTry(['-C', opts.root, 'branch', '-d', c.branch]);
    if (del.code === 0) {
      rep.branches.push(c.branch);
    } else {
      rep.kept.push(
        `${c.branch} (${/not fully merged/i.test(del.err) ? 'unlanded commits' : 'branch delete refused'})`
      );
    }
    return;
  }
  deleteMergedLocalBranch(c.branch, pr.mergedSha);
  if (
    gitTry(['-C', opts.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`]).code !==
    0
  ) {
    rep.branches.push(c.branch);
  } else {
    rep.kept.push(`${c.branch} (branch delete refused)`);
  }
}

// --- claim liveness + release (spec bro-ho09d) ----------------------------------
//
// A claim is only as real as its worker: `in_progress` with every
// ownership plane dead is an orphan — release the claim so the bead
// re-queues, then the tree flows through the same verdicts as any
// open-bead litter. Every plane fails CLOSED (unverifiable = live):
// releasing a live worker's claim is the worst outcome this code can
// produce.

/** The claim's live owner, or undefined when every plane is dead. */
function claimOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  // every plane fails closed — first live (or unverifiable) owner wins
  return (
    runRecordOwner(ctx, c, bead) ??
    registryOwner(ctx, c, bead) ??
    sessionOwner(ctx, c) ??
    watchOwner(ctx, c, bead) ??
    treeProcessOwner(c)
  );
}

/** loop run records — collectLoopRuns already judged pid+pidStart;
 *  beadIds covers the whole claimed clump, not just the lead */
function runRecordOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  for (const v of ctx.claims.runs) {
    if (
      v.state === 'running' &&
      (v.beadId === bead.id || v.beadIds?.includes(bead.id) === true || v.slug === c.slug)
    ) {
      return `loop worker pid ${v.pid} live`;
    }
  }
  return undefined;
}

/** agent registry — an unreadable plane is not a dead worker */
function registryOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  const { claims } = ctx;
  if (claims.registry === undefined) {
    return 'agent registry unreadable';
  }
  for (const [molStep, e] of Object.entries(claims.registry)) {
    const hitsBead = molStep === bead.id;
    const hitsTree =
      c.w !== undefined &&
      typeof e.worktree === 'string' &&
      resolve(e.worktree) === resolve(c.w.path);
    if ((hitsBead || hitsTree) && registryEntryHoldsClaim(claims.agentsHome, e)) {
      return `agent ${e.agentId || molStep} live`;
    }
  }
  return undefined;
}

/** A live ledger claim naming this candidate — the marker/arm-detail
 *  legs' machine-wide twin (bro-izpyk.10). `worktree:` binds by path
 *  first, then by its recorded detail like a marker line; `branch:`
 *  binds by name/detail the same way. `ids` lets a `.task`-style claim
 *  carry the full bead id (same widening sessionOwner's marker leg
 *  gets). */
function sessionClaimOn(
  rows: ClaimRow[],
  c: LitterCandidate,
  ids: string[] = []
): ClaimRow | undefined {
  return rows.find(row => {
    const r = row.resource;
    if (r.startsWith('worktree:')) {
      const path = r.slice('worktree:'.length);
      if (c.w !== undefined && resolve(path) === resolve(c.w.path)) {
        return true;
      }
      const probe = row.detail || basename(path);
      return (
        detailMatches(probe, { branch: c.branch, slug: c.slug, worktree: c.w?.path }) ||
        ids.includes(probe)
      );
    }
    if (r.startsWith('branch:')) {
      return detailMatches(row.detail || r.slice('branch:'.length), {
        branch: c.branch,
        slug: c.slug,
        worktree: c.w?.path,
      });
    }
    return false;
  });
}

/** session markers — `bd --claim` arms .task, `bro work enter` arms .work */
function sessionOwner(ctx: LitterCtx, c: LitterCandidate): string | undefined {
  // a .task marker carries the full bead id (`bd update <bead> --claim`)
  // — branch/slug/worktree matching alone misses it for short label
  // slugs (`work/imvu3` → `bro-imvu3`), so the resolved row's ids join
  // the match set
  const bead = litterBead(ctx, c);
  const ids = bead === undefined ? [] : [bead.id, loopSlug(bead.id)];
  const detail = ctx.claims.sessionDetails.find(
    d =>
      detailMatches(d, { branch: c.branch, slug: c.slug, worktree: c.w?.path }) || ids.includes(d)
  );
  if (detail !== undefined) {
    return `session armed ${detail}`;
  }
  // ledger claims — the marker leg's cross-session twin (bro-izpyk.10):
  // a live `worktree:`/`branch:` lease naming this candidate is the
  // same keep-reason, machine-wide
  const claim = sessionClaimOn(ctx.claims.sessionClaims, c, ids);
  return claim === undefined
    ? undefined
    : `session ${claim.sid.slice(0, 8)} claims ${claim.resource}`;
}

/** live watch markers — a landed member's claim rides its act wait
 *  (bro-q6ppv): the loop services the gate stack past the worker's exit */
function watchOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  for (const l of ctx.claims.watches) {
    if (!l.alive) {
      continue;
    }
    // a clump's whole id list rides the marker comma-joined (bro-q6ppv)
    const hitsBead = l.watch.bead?.split(',').includes(bead.id) === true;
    const hitsTree =
      c.w !== undefined &&
      typeof l.watch.workdir === 'string' &&
      resolve(l.watch.workdir) === resolve(c.w.path);
    if (hitsBead || hitsTree) {
      return `watch on ${l.watch.link} live`;
    }
  }
  return undefined;
}

/** a live agent-shaped process inside the tree — covers a worker that
 *  never registered (spawn crashed after fork, record write lost) */
function treeProcessOwner(c: LitterCandidate): string | undefined {
  if (c.w === undefined) {
    return undefined;
  }
  const hit = agentProcessesIn(c.w.path)[0];
  return hit === undefined ? undefined : `process ${hit.pid} live in tree`;
}

/** Release an orphaned claim — every plane dead. Runs the final
 *  liveness re-check and the note+reopen inside the shared registry
 *  lock: a respawn's claim→register writes under the same lock, so a
 *  worker landing during our wait either shows up in the re-read or
 *  claims after we've released (the reopened bead is then its target —
 *  correct). Returns the keep reason when the claim survives,
 *  undefined when it was released (or would be, under dry-run). */
function releaseDeadClaim(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  const { opts, rep } = ctx;
  const pre = claimOwner(ctx, c, bead);
  if (pre !== undefined) {
    return pre;
  }
  let release: () => void;
  try {
    release = acquireAgentRegistryLock(ctx.main.path);
  } catch {
    return 'occupancy lock contended';
  }
  try {
    // re-read under the lock — the snapshot predates the wait, and a
    // respawn's registry write lands inside this same section
    let registry: Record<string, AgentRegistryEntry> | undefined;
    try {
      registry = readAgentRegistry(opts.root);
    } catch {
      registry = undefined;
    }
    const owner = claimOwner({ ...ctx, claims: { ...ctx.claims, registry } }, c, bead);
    if (owner !== undefined) {
      return owner;
    }
    if (opts.dryRun !== true) {
      try {
        opts.tasks.note(
          bead.id,
          'bro work prune --loop: released orphaned claim — every worker-liveness plane is dead (bro-ho09d)'
        );
        opts.tasks.reopen(bead.id);
      } catch (err) {
        rep.errors.push(
          `claim release for ${bead.id} failed — ${err instanceof Error ? err.message : err}`
        );
        return 'claim release failed';
      }
    }
    // the snapshot row drives the rest of the sweep's verdicts
    bead.status = 'open';
    rep.released.push(`${bead.id} (no live worker)`);
    return undefined;
  } finally {
    release();
  }
}

/** One candidate: claim liveness first (an in_progress bead with a dead
 *  worker is an orphan — released, then judged as open-bead litter),
 *  then the evidence verdict, then — for a worktree'd branch — the
 *  tree guards and the removal as ONE locked section. The shared
 *  registry lock is the same one claimWorktree and finishWorktreeEnter
 *  hold across their claim→stamp / check→remove spans: without it a
 *  claimant or respawned fixer can pin the path after the check and
 *  lose its live tree to the removal (bro-qry9, bro-0fiq). A lock
 *  contended past the bound is itself a claimant mid-act → keep. A
 *  failed removal keeps the branch too — it is still checked out there. */
function reapCandidate(c: LitterCandidate, ctx: LitterCtx, parked: ParkedCand[]): void {
  const { opts, rep, main } = ctx;
  const pr = litterPrEvidence(opts, c.branch);
  const label = c.w?.path ?? c.branch;
  const bead = litterBead(ctx, c);
  if (bead?.status === 'in_progress' && opts.keepClaims?.has(bead.id) !== true) {
    const owner = releaseDeadClaim(ctx, c, bead);
    if (owner !== undefined) {
      rep.kept.push(`${label} (bead in_progress — ${owner})`);
      return;
    }
    // released — the bead reads open for the verdicts below
  }
  const done = litterDoneVerdict(c, ctx, pr);
  if (done !== undefined) {
    // open/non-terminal beads keep their tree only as resume cache —
    // they pool; every other keep reason is unconditional. A PR veto
    // (open or unreadable) never pools — the work is visibly in flight
    if (
      c.w !== undefined &&
      bead !== undefined &&
      bead.status !== 'closed' &&
      pr.known &&
      !pr.open
    ) {
      parked.push({ c, pr, done });
      return;
    }
    rep.kept.push(`${label} (${done})`);
    return;
  }
  if (c.w === undefined) {
    retireLitterBranch(c, ctx, pr);
    return;
  }
  let release: () => void;
  try {
    release = acquireAgentRegistryLock(main.path);
  } catch {
    rep.kept.push(`${label} (occupancy lock contended)`);
    return;
  }
  try {
    const why = litterTreeVerdict(c, ctx);
    if (why !== undefined) {
      rep.kept.push(`${label} (${why})`);
      return;
    }
    if (opts.dryRun !== true && !removeMergedWorktree(c.w.path, c.w, main)) {
      rep.errors.push(`worktree ${c.w.path} not removed`);
      return;
    }
    rep.reaped.push(litterReapedLabel(c));
  } finally {
    release();
  }
  retireLitterBranch(c, ctx, pr);
}

interface ParkedCand {
  c: LitterCandidate;
  pr: PrEvidence;
  /** the keep reason the candidate earned — reported for survivors */
  done: string;
}

/** The reaped-line label — '<path> [<branch>]', or '(detached)' when no
 *  branch could be attributed to the tree. */
function litterReapedLabel(c: LitterCandidate): string {
  return c.branch === '' ? `${c.w?.path ?? c.slug} (detached)` : `${c.w?.path} [${c.branch}]`;
}

/** The parked pool pass — open-bead trees kept only as a resume cache,
 *  bounded by `parkedKeep`/`parkedTtlDays` (spec bro-ho09d). Newest
 *  first; a dirty/locked/claimed/occupied tree keeps outright and never
 *  consumes a pool slot — it is data, not cache. Evictions keep the
 *  branch (cheap) via the same retire rule done litter uses. */
function reapParkedPool(parked: ParkedCand[], ctx: LitterCtx): void {
  const { opts } = ctx;
  if (parked.length === 0) {
    return;
  }
  const now = opts.now ?? Date.now();
  const keepN = opts.parkedKeep ?? 0;
  const ttlMs = (opts.parkedTtlDays ?? 0) * 24 * 60 * 60 * 1000;
  const scored = parked
    .map(p => ({ ...p, idle: worktreeIdleMs(p.c.w!.path, now) }))
    .sort((a, b) => a.idle - b.idle);
  let kept = 0;
  for (const { c, pr, done, idle } of scored) {
    kept += reapParkedCand({ c, pr, done, idle }, kept, keepN, ttlMs, ctx);
  }
}

/** One parked candidate's verdict under the registry lock — returns the
 *  pool-slot delta: 1 when the tree survives on cache merit (it counts
 *  against `parkedKeep`), 0 when it was reaped or kept outright. */
function reapParkedCand(
  p: ParkedCand & { idle: number },
  kept: number,
  keepN: number,
  ttlMs: number,
  ctx: LitterCtx
): number {
  const { opts, rep, main } = ctx;
  const { c, pr, done, idle } = p;
  const label = c.w!.path;
  let release: () => void;
  try {
    release = acquireAgentRegistryLock(main.path);
  } catch {
    rep.kept.push(`${label} (occupancy lock contended)`);
    return 0;
  }
  try {
    const held = litterTreeVerdict(c, ctx);
    if (held !== undefined) {
      rep.kept.push(`${label} (${held})`);
      return 0;
    }
    const overCap = keepN > 0 && kept >= keepN;
    const stale = ttlMs > 0 && idle > ttlMs;
    if (!overCap && !stale) {
      rep.kept.push(`${label} (${done})`);
      return 1;
    }
    if (opts.dryRun !== true && !removeMergedWorktree(c.w!.path, c.w!, main)) {
      rep.errors.push(`worktree ${c.w!.path} not removed`);
      return 0;
    }
    const verdict = stale ? 'idle past TTL' : `over cap ${keepN}`;
    rep.reaped.push(`${litterReapedLabel(c)} — parked pool ${verdict}`);
  } finally {
    release();
  }
  retireLitterBranch(c, ctx, pr);
  return 0;
}

/** An nx daemon's argv signature — `<wt>/node_modules/nx/dist/src/
 *  daemon/server/start.js`, a long-lived helper nx respawns on demand:
 *  never a worker, never work. Its cwd/argv inside the tree roots it
 *  on every /proc occupancy plane all the same, so a dead fixer's
 *  orphaned daemon pins the tree "live" and a safe reap reads as
 *  occupied (bro-7dgu3 — verified live: trees held by nothing else). */
const NX_DAEMON_SCRIPT_RE = /nx[/\\]dist[/\\]src[/\\]daemon[/\\]server[/\\]start\.js$/;

/** argv[0] is a node binary (`node`, `…/node`, `node.exe`) AND its
 *  script argument is the daemon's start.js — a flattened-argv
 *  substring match would SIGTERM any process merely carrying the path
 *  as data (`vim <path>`, `cp <path> …`); the script position is the
 *  daemon's shape (codeant, #975). */
export function isNxDaemonCmd(cmd: string): boolean {
  const argv = cmd.split(' ').filter(Boolean);
  const exe = argv[0]?.split(/[/\\]/).pop() ?? '';
  if (!/^node(\.\w+)?$/.test(exe)) {
    return false;
  }
  const script = argv.slice(1).find(t => !t.startsWith('-'));
  return script !== undefined && NX_DAEMON_SCRIPT_RE.test(script);
}

/** Bound the SIGTERM→exit wait — the reap's own rooted-scan must see a
 *  signalled ghost gone in THIS pass, not one sweep later. */
const NX_KILL_WAIT_MS = 2_000;

export interface NxDaemonReapOpts {
  dryRun?: boolean;
  /** Injectable rooted-process scan — tests stub it; production is
   *  processesRootedIn (every occupant, not only agent-shaped). */
  scan?: (worktree: string) => ProcHit[];
  /** Injectable signal/liveness — tests never signal real pids. */
  kill?: (pid: number) => void;
  alive?: (pid: number) => boolean;
  /** Bound on the post-SIGTERM wait — interactive callers keep the
   *  default so this pass's verdict scan sees the ghosts gone; the
   *  drive daemon passes 0 (a sync wait would freeze its event loop —
   *  the next sweep's scan reaps once the daemons exit). */
  waitMs?: number;
}

/** Kill stale nx daemons rooted in the candidate trees — bounded to
 *  trees whose EVERY rooted process is daemon-shaped: the only live
 *  thing left is disposable infrastructure. One non-daemon hit keeps
 *  hands off the whole tree — a live session's daemon keeps company.
 *  Returns the kill-report lines, 'nx daemon pid N (<path>)' — pushed
 *  under dryRun too (the 'would' list); no signals are sent then. */
export function reapStaleNxDaemons(worktrees: string[], opts: NxDaemonReapOpts = {}): string[] {
  const scan = opts.scan ?? ((wt: string) => processesRootedIn(wt));
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const alive = opts.alive ?? pidAlive;
  const killed: string[] = [];
  const pids: number[] = [];
  for (const wt of worktrees) {
    let rooted: ProcHit[];
    try {
      rooted = scan(wt);
    } catch {
      continue; // unverifiable — the verdict layer keeps the tree
    }
    if (rooted.length === 0 || !rooted.every(h => isNxDaemonCmd(h.cmd))) {
      continue;
    }
    for (const h of rooted) {
      if (opts.dryRun !== true) {
        try {
          kill(h.pid);
          pids.push(h.pid);
        } catch {
          // already gone — nothing pinned
        }
      }
      killed.push(`nx daemon pid ${h.pid} (${wt})`);
    }
  }
  // let the SIGTERMs land before the verdicts' own rooted-scans — a
  // still-dying daemon would pin its tree for one more sweep. Skipped
  // at waitMs:0 — the caller chose the next sweep's scan over blocking
  // this thread (the drive loop's async lane; Atomics.wait stalls every
  // pending promise for the bound, amazon-q on #975)
  const waitMs = opts.waitMs ?? NX_KILL_WAIT_MS;
  const deadline = Date.now() + waitMs;
  while (waitMs > 0 && pids.some(pid => alive(pid)) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return killed;
}

export function reapLoopLitter(opts: LitterReapOpts): LitterReap {
  const rep: LitterReap = {
    reaped: [],
    branches: [],
    released: [],
    repaired: [],
    killed: [],
    kept: [],
    errors: [],
  };
  const found = litterCandidates(opts, rep);
  if (found === undefined) {
    return rep;
  }
  // stale nx daemons pin candidate trees on every /proc plane — kill
  // them before the claim and verdict scans read ghosts as occupants
  rep.killed.push(
    ...reapStaleNxDaemons(
      found.cands.flatMap(c => (c.w === undefined ? [] : [c.w.path])),
      { dryRun: opts.dryRun, waitMs: opts.nxKillWaitMs }
    )
  );
  const bySlug = litterBeads(opts, rep);
  if (bySlug === undefined) {
    return rep;
  }
  // the store's id prefix — label short slugs resolve through the
  // '<prefix>-<slug>' form; a probe failure stays fail-closed (that
  // rung just skips) but the store error belongs in the report —
  // short slugs left unresolved otherwise read as plain 'no bead'
  let prefix: string | undefined;
  try {
    prefix = opts.tasks.prefix();
  } catch (err) {
    rep.errors.push(
      `task store prefix probe failed — ${err instanceof Error ? err.message : String(err)}`
    );
    prefix = undefined;
  }
  // claim-liveness planes — snapshotted once for the sweep; the release
  // re-reads the registry inside the lock before writing
  const regPath = agentRegistryPath(opts.root);
  const hooks = hooksDirOf(opts.root);
  let registry: Record<string, AgentRegistryEntry> | undefined;
  try {
    registry = readAgentRegistry(opts.root);
  } catch {
    registry = undefined;
  }
  const ctx: LitterCtx = {
    opts,
    rep,
    main: found.main,
    bySlug,
    prefix,
    claims: {
      runs: collectLoopRuns(opts.root, opts.now ?? Date.now()),
      registry,
      agentsHome: regPath === null ? null : join(dirname(regPath), 'agents'),
      sessionDetails:
        hooks === null ? [] : liveWorkDetails(hooks, ['.work', '.task'], opts.now ?? Date.now()),
      sessionClaims: opts.sessionClaims ?? [],
      watches: listWatches(opts.root),
    },
  };
  const parked: ParkedCand[] = [];
  for (const c of found.cands) {
    reapCandidate(c, ctx, parked);
  }
  reapParkedPool(parked, ctx);
  releaseOrphanedRuns(found.cands, ctx);
  return rep;
}

/** Dead run records whose beads still read in_progress — litter may
 *  have been hand-cleaned already; the claim is still orphaned. A
 *  record's beadIds covers every clump member, not only the lead. */
function releaseOrphanedRuns(cands: LitterCandidate[], ctx: LitterCtx): void {
  const handled = new Set(cands.map(c => litterBead(ctx, c)?.id).filter(Boolean));
  for (const v of ctx.claims.runs) {
    if (v.state !== 'dead') {
      continue;
    }
    const ids = [...new Set([v.beadId, ...(v.beadIds ?? [])])];
    for (const id of ids) {
      const bead = ctx.bySlug.get(loopSlug(id)) ?? ctx.bySlug.get(v.slug);
      if (
        bead === undefined ||
        bead.status !== 'in_progress' ||
        handled.has(bead.id) ||
        ctx.opts.keepClaims?.has(bead.id) === true
      ) {
        continue;
      }
      // the record's worktree still narrows the owner check — a live
      // process inside it (or a marker naming it) keeps the claim even
      // with the tree already hand-cleaned to a bare path
      releaseDeadClaim(
        ctx,
        {
          branch: '',
          slug: loopSlug(bead.id),
          w:
            v.worktree === undefined
              ? undefined
              : { path: v.worktree, head: '', bare: false, detached: false },
        },
        bead
      );
    }
  }
}
