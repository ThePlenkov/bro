/**
 * `bro stack` — a named stack is a VIEW over the `stack/<name>/<n>-<slug>`
 * branch namespace plus the `.git/bro/stack/` edges `work enter` writes:
 * member N's branch forks from member N-1's, its PR targets that branch,
 * and merges cascade bottom-up. There is no parallel registry — a dead
 * branch or removed worktree simply drops out of the view.
 *
 *   bro stack push <bead> [--name <stack>]
 *                       sibling worktree <repo>--<bead> on branch
 *                       stack/<name>/<n>-<slug> based on the stack tip
 *                       (first member bases on the default branch)
 *   bro stack list [<name>]   the chain: position, bead, branch, base,
 *                             worktree state, PR
 *   bro stack sync [<name>]   after a member merges: retarget open child
 *                             PRs and rebase child branches onto the new
 *                             base; dirty or locked worktrees are skipped
 *                             and reported — the owner rebases on enter
 *   bro stack publish [<name>]
 *                       register the chain's open member PRs as the
 *                       host's server-side stack (GitHub's Stack object
 *                       via `gh stack link`); hosts that detect chains
 *                       themselves (GitLab, plain git) decline the call
 */
import { basename } from 'node:path';
import {
  acquireFileLock,
  countMergesInRange,
  facade,
  gitTry,
  LockTimeout,
  MANUAL_CASCADE,
  mergeChainPerLayer,
  hasHelpFlag,
  printUsage,
  reviewHost,
  shQuote,
  stackHost,
  type PrMeta,
  type ReviewFacade,
  type StackCascade,
  type StackChainMember,
  type StackFacade,
  type StackMergeOpts,
} from '@broject/core';
import type { ExitCode } from '@broject/core';
import {
  acquireMergeSlot,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  resolveLedger,
  releaseMergeSlot,
} from '@broject/act';
import {
  displayBase,
  formatStackBranch,
  isStackName,
  nextIndex,
  parseStackBranch,
  planSync,
  stackMembers,
  stackNames,
  stackTop,
  type SyncMemberInput,
  type SyncPlanItem,
} from '@broject/stack';
import { flag, positionals } from './args.ts';
import { loadBroConfig } from '../plugins.ts';
import {
  createWorktree,
  dirtyCount,
  finishWorktreeEnter,
  mainWorktree,
  defaultBranchName,
  parseWorktreePorcelain,
  readStackEdges,
  recordStackEdge,
  removeStackEdge,
  stackPushLockPath,
  stateOfWorktree,
  type EnterWorktreeResult,
  type WorktreeCreateResult,
  type WorktreeInfo,
} from './work.ts';

const NAME_FLAGS = new Set(['--name']);

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `usage:
  bro stack push <bead> [--name <stack>]
  bro stack list [<name>]
  bro stack sync [<name>]
  bro stack publish [<name>]
  bro stack merge [<name>] [--squash|--merge|--rebase] [--admin]`,
    exitCode
  );
}

function allBranches(dir: string): string[] {
  return gitTry(['-C', dir, 'branch', '--format=%(refname:short)'])
    .out.split('\n')
    .map(b => b.trim())
    .filter(Boolean);
}

function localBranch(dir: string, name: string): boolean {
  return gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).code === 0;
}

/** The base's usable commit-ish — the LOCAL head first, then the
 *  remote-tracking ref (bro-yi9sz).
 *
 *  Git's rev-parse never falls back from `main` to `origin/main`: the
 *  shorthand names `refs/heads/main`, the tracking branch is
 *  `origin/main`. So a repository whose default branch has no local
 *  branch (a checkout that never created it, a default branch renamed
 *  on the remote) reads every base as dead — the chain is unsyncable
 *  and every member is skipped with a reason.
 *
 *  The NAME stays the name: the PR retarget and the recorded stack edge
 *  need the branch name, not a ref. Only the git reads take the
 *  commit-ish. `undefined` when the base exists nowhere — the old
 *  answer, and the only honest one. */
export function baseRef(dir: string, base: string): string | undefined {
  const local = `refs/heads/${base}`;
  if (gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', local]).code === 0) {
    return local;
  }
  for (const remote of remotesOf(dir)) {
    const tracking = `refs/remotes/${remote}/${base}`;
    if (gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', tracking]).code === 0) {
      return tracking;
    }
  }
  return undefined;
}

/** The configured remotes, `origin` first — the conventional remote is
 *  the one a default branch tracks. */function remotesOf(dir: string): string[] {
  const names = gitTry(['-C', dir, 'remote'])
    .out.split('\n')
    .map(r => r.trim())
    .filter(r => r !== '');
  const origin = names.filter(r => r === 'origin');
  return [...origin, ...names.filter(r => r !== 'origin')];
}

/** The rebase target — the base's usable commit-ish (bro-yi9sz). The
 *  NAME stays the name for the PR retarget and the recorded edge; only
 *  the git call takes the ref. */
function ontoBase(dir: string, base: string): string {
  return baseRef(dir, base) ?? base;
}

/** Stack name resolution: --name wins, else the current worktree's own
 *  `stack/<name>/…` branch (push from inside a member extends that
 *  stack), else it must be given — guessing a name would scatter
 *  branches across stacks nobody asked for. */
function resolveStackName(argv: string[]): string {
  const explicit = flag(argv, '--name');
  if (explicit !== undefined) {
    if (!isStackName(explicit)) {
      console.error(`error: invalid stack name "${explicit}" ([a-z0-9_.-])`);
      process.exit(2);
    }
    return explicit;
  }
  const cur = parseStackBranch(gitTry(['branch', '--show-current']).out.trim());
  if (cur) {
    return cur.name;
  }
  console.error('error: no stack context — pass --name <stack>');
  usage();
}

/** The live member carrying this bead's slug — a re-push re-enters that
 *  member instead of minting a second position for the same bead. */
export function stackMemberFor(dir: string, name: string, slug: string) {
  return stackMembers(allBranches(dir), name).find(m => m.slug === slug);
}

/** One PR per stack member, newest first: OPEN wins, else the most
 *  recent MERGED/CLOSED. `prsForBranch(branch, 'all')` lists every
 *  state — without it a merged member is invisible to sync. */
function memberPr(
  rev: { repo: string; facade: ReviewFacade },
  branch: string
): { pr: number; meta: PrMeta } | undefined {
  const prs = rev.facade.prsForBranch(branch, 'all');
  let merged: { pr: number; meta: PrMeta } | undefined;
  for (const pr of prs.slice(0, 5)) {
    const meta = rev.facade.prMeta({ repo: rev.repo, pr });
    if (meta.state === 'OPEN') {
      return { pr, meta };
    }
    merged ??= { pr, meta };
  }
  return merged;
}

/** Branches of members whose PR reports MERGED — dead ends for tip
 *  selection even while the branch still exists. `undefined` when the
 *  host can't answer (offline → conservative: nothing reads as merged). */
export function mergedBranches(
  dir: string,
  name: string,
  rev: { repo: string; facade: ReviewFacade } | undefined
): ReadonlySet<string> | undefined {
  if (rev === undefined) {
    return undefined;
  }
  const dead = new Set<string>();
  for (const m of stackMembers(allBranches(dir), name)) {
    try {
      if (memberPr(rev, m.branch)?.meta.state === 'MERGED') {
        dead.add(m.branch);
      }
    } catch {
      // host unreachable mid-lookup — the member stays live, the
      // conservative answer
    }
  }
  return dead;
}

/** The stack tip for a push: the highest-n LIVE member branch. A merged
 *  member's branch is a dead end — its commits already reached the
 *  default branch — so `dead` members are skipped; the next member then
 *  bases on the nearest live member (or the default branch) and gets
 *  the next position number (merged slots are never reused). */
export function stackTip(
  dir: string,
  name: string,
  dead?: ReadonlySet<string>
): { n: number; base?: string } {
  const members = stackMembers(allBranches(dir), name);
  return { n: nextIndex(members), base: stackTop(members, dead)?.branch };
}

function cmdPush(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS);
  const slug = pos[0];
  // same contract parseStackBranch applies — a slug it rejects would
  // mint a member branch the stack view can never see
  if (!slug || !isStackName(slug)) {
    console.error('error: push needs a bead/slug (git-ref-safe: [a-z0-9_.-], no leading ./-)');
    usage();
  }
  const name = resolveStackName(argv);
  const main = mainWorktree();
  const defaultRef = defaultBranchName();
  // the push lock serializes member-listing → worktree-add across bro
  // processes: without it two concurrent pushes (loop workers, push +
  // loop racing) read the same tip and both mint position n under
  // different slugs. The section ends at `worktree add` — once the
  // branch exists a waiter's recompute sees it; the slower post-add
  // steps (submodule init, bead claim) stay outside the hold.
  const lockPath = stackPushLockPath(name);
  if (lockPath === null) {
    console.error('note: could not resolve the git common dir — pushing without the stack lock');
  }
  let release: (() => void) | undefined;
  try {
    release =
      lockPath === null
        ? undefined
        : acquireFileLock(lockPath, { label: `stack ${name} push lock` });
  } catch (err) {
    if (err instanceof LockTimeout) {
      console.error(`error: ${err.message} — another push is in flight; retry`);
    } else {
      console.error(`error: ${(err as Error).message}`);
    }
    process.exit(1);
  }
  let n: number;
  let created: WorktreeCreateResult;
  let base: string | undefined;
  let reenter = false;
  try {
    // re-pushing a bead that already sits in the stack re-enters its member
    // branch — push is idempotent, never a duplicate position
    const existing = stackMemberFor(main.path, name, slug);
    reenter = existing !== undefined;
    const rev = resolveReview(main.path);
    const dead = existing === undefined ? mergedBranches(main.path, name, rev) : undefined;
    const tip = existing === undefined ? stackTip(main.path, name, dead) : undefined;
    n = existing?.n ?? tip!.n;
    const branch = existing?.branch ?? formatStackBranch(name, n, slug);
    base =
      (existing === undefined ? undefined : readStackEdges().get(existing.branch)) ??
      tip?.base ??
      defaultRef ??
      main.branch ??
      main.head;
    created = createWorktree({
      slug,
      branch,
      base: existing === undefined ? base : undefined,
      main,
      defaultRef,
      allowExisting: existing !== undefined,
      reusePath: existing !== undefined,
    });
  } finally {
    release?.();
  }
  const r = finishWorktreeEnter(
    {
      slug,
      branch: created.branch,
      base: reenter ? undefined : base,
      main,
      defaultRef,
    },
    created
  );
  reportPush(r, name, n, base, slug, resolveStacks(main.path));
}

/** Push result reporting — a `gone` worktree was retired by a driver
 *  before the claim landed, so the push aborts instead of printing a
 *  dead path as ready. */
function reportPush(
  r: EnterWorktreeResult,
  name: string,
  n: number,
  base: string | undefined,
  slug: string,
  stacks: StackFacade | undefined
): void {
  if (r.claimLockTimedOut) {
    console.error(
      `error: claim lock for ${r.path} timed out — ` +
        (r.partialRemoved === true
          ? 'removed the partial worktree; retry push'
          : `worktree left at ${r.path} — inspect it before retrying`)
    );
    process.exit(1);
  }
  if (r.gone) {
    console.error(`error: ${r.path} was retired before the claim could land — aborting`);
    process.exit(1);
  }
  console.log(`worktree ready: ${r.path}  (branch ${r.branch})`);
  console.log(`stack ${name} member ${n} — based on ${r.base ?? base ?? 'HEAD'}`);
  if (r.stacked) {
    // the hint is the connector's — `gh pr create`, `glab mr create`, or
    // nothing on a forge-less host. An unresolved facade keeps the gh
    // text: still the most likely intent in that failure mode.
    const hint =
      stacks?.openHint?.({ branch: r.branch, base: r.base ?? '' }) ??
      (stacks === undefined && r.base !== undefined
        ? `gh pr create --base ${shQuote(r.base)}`
        : undefined);
    if (hint !== undefined) {
      console.log(`open the PR against the parent member: ${hint}`);
    }
  }
  if (r.claim.claimed) {
    console.log(`claimed bead ${r.claim.claimed} for this session`);
  } else if (r.claim.refused) {
    console.error(`note: could not claim bead ${slug} — another actor may hold it`);
  }
}

interface MemberView extends SyncMemberInput {
  pr?: number;
  headSha?: string;
  worktree?: WorktreeInfo;
}

/** Why a member can't be rewritten locally — the skip report's reason. */
function blockedReason(w: WorktreeInfo | undefined, dirty: number): string | undefined {
  if (w === undefined) {
    return 'no worktree';
  }
  if (w.locked !== undefined) {
    return w.locked === '' ? 'locked' : `locked (${w.locked})`;
  }
  if (dirty < 0) {
    return 'worktree gone';
  }
  return dirty === 0 ? undefined : `dirty worktree (${dirty} file(s))`;
}

/** PR state onto a member — OPEN/MERGED base + state; a failing host is
 *  not fatal: the fields stay undefined and the member reads as
 *  unmerged, which is the conservative answer for sync. */
function attachPr(m: MemberView, rev: { repo: string; facade: ReviewFacade } | undefined): void {
  if (rev === undefined) {
    return;
  }
  try {
    const hit = memberPr(rev, m.branch);
    if (hit !== undefined) {
      m.pr = hit.pr;
      m.prState = hit.meta.state;
      m.prBase = hit.meta.baseRef;
      m.headSha = hit.meta.headSha;
    }
  } catch {
    // host unreachable — member reads as unmerged/untargeted
  }
}

/** Live member state: branch namespace + edges + worktrees + PRs. */
function collectMembers(
  name: string,
  root: string,
  rev?: { repo: string; facade: ReviewFacade }
): MemberView[] {
  const edges = readStackEdges();
  const trees = new Map(
    parseWorktreePorcelain(gitTry(['-C', root, 'worktree', 'list', '--porcelain']).out)
      .filter(w => w.branch !== undefined)
      .map(w => [w.branch as string, w])
  );
  return stackMembers(allBranches(root), name).map(b => {
    const w = trees.get(b.branch);
    const dirty = !w?.path ? -1 : dirtyCount(w.path);
    const blocked = blockedReason(w, dirty);
    const m: MemberView = {
      ...b,
      edgeBase: edges.get(b.branch),
      worktree: w,
      rebaseable: blocked === undefined,
      blocked,
    };
    attachPr(m, rev);
    return m;
  });
}

function resolveReview(root: string): { repo: string; facade: ReviewFacade } | undefined {
  try {
    const facade = reviewHost(root, loadBroConfig(root).connectors);
    return { repo: facade.resolveRepo([]), facade };
  } catch {
    return undefined;
  }
}

/** The connector's stack semantics for this repo — undefined when no
 *  connector serves `stacks` (no remote match, nothing authed). The
 *  caller's answer to that is the universal one: manual retarget, local
 *  rebase, no forge ops. A pinned `connectors.reviews` is also the
 *  stacks default when it serves the facade: self-hosted forges (GHES,
 *  self-managed GitLab) never matchRemote, so the git dir-match would
 *  otherwise win and the repo would lose the forge's openHint and
 *  cascade semantics. An explicit `connectors.stacks` still wins. */
function resolveStacks(root: string): StackFacade | undefined {
  try {
    const connectors = loadBroConfig(root).connectors;
    if (connectors.stacks === undefined && connectors.reviews !== undefined) {
      try {
        return facade('stacks', { dir: root }, { connector: connectors.reviews });
      } catch {
        // the pinned reviews connector doesn't serve stacks — resolve normally
      }
    }
    return stackHost(root, connectors);
  } catch {
    return undefined;
  }
}

/** One member row in `stack list` — position, slug, branch, effective
 *  base, worktree state, PR state + target. */
function memberLine(
  m: MemberView,
  defaultBase: string,
  rev: { repo: string; facade: ReviewFacade } | undefined,
  root: string
): string {
  const stale =
    m.edgeBase !== undefined && m.edgeBase !== defaultBase && !localBranch(root, m.edgeBase);
  const wt =
    m.worktree === undefined
      ? 'no-worktree'
      : `${basename(m.worktree.path)} ${stateOfWorktree(m.worktree)}`;
  let pr = 'PR?'; // no review host resolved — can't tell
  if (rev !== undefined) {
    pr =
      m.pr === undefined
        ? 'no-PR'
        : `${rev.facade.prLink(rev.repo, m.pr)} ${m.prState}→${m.prBase}`;
  }
  const base = displayBase(m, defaultBase);
  return `  ${m.n}  ${m.slug}  ${m.branch}  base ${base}${stale ? ' (stale edge)' : ''}  ${wt}  ${pr}`;
}

function cmdList(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS);
  const main = mainWorktree();
  const defaultBase = defaultBranchName() ?? main.branch ?? 'main';
  const branches = allBranches(main.path);
  const names = pos[0] ? [pos[0]] : stackNames(branches);
  if (names.length === 0) {
    console.log('no stacks — `bro stack push <bead> --name <stack>` starts one');
    return;
  }
  const rev = resolveReview(main.path);
  const stacks = resolveStacks(main.path);
  for (const name of names) {
    const members = collectMembers(name, main.path, rev);
    console.log(`stack ${name}  (${members.length} member${members.length === 1 ? '' : 's'})`);
    for (const m of members) {
      console.log(memberLine(m, defaultBase, rev, main.path));
    }
    // the publish hint needs both caps: membership detects the gap,
    // publish is the fix it names. Neither present → the host has no
    // stack registry and there is nothing to hint at.
    if (stacks?.publish !== undefined && stacks.membership !== undefined) {
      const open = members.filter(m => m.pr !== undefined && m.prState === 'OPEN');
      const unstacked = open.filter(m => stacks.membership!(m) === null);
      if (open.length >= 2 && unstacked.length > 0) {
        console.log(
          `  ${unstacked.length} of ${open.length} open member PRs not in a stack on the host — \`bro stack publish ${name}\``
        );
      }
    }
  }
}

/** A merged member leaves the chain — its edge goes, and its branch
 *  goes too when no worktree still holds it (a checked-out branch can't
 *  be deleted; the owner's worktree keeps it until `work leave`). */
function retireMerged(m: MemberView, root: string, lines: string[]): void {
  removeStackEdge(m.branch);
  if (m.worktree !== undefined) {
    lines.push(`  ${m.branch} merged — leaves the chain (worktree keeps the branch)`);
    return;
  }
  const del = gitTry(['-C', root, 'branch', '-D', m.branch]);
  lines.push(
    del.code === 0
      ? `  ${m.branch} merged — edge + branch removed`
      : `  ${m.branch} merged — edge removed, branch kept (${del.err.trim() || 'delete failed'})`
  );
}

/** The branch a member stands on — its recorded edge (the fork truth
 *  the plan reads), else its PR's declared base, else the chain's
 *  previous member. The order matches `planSync`'s own resolution: one
 *  answer, or the head check and the planner read different bases and
 *  disagree about whether the member is current. */
function baseOf(m: MemberView, prev: string): string {
  return m.edgeBase ?? m.prBase ?? prev;
}

/**
 * Does the branch still carry the head of the base it stands on? The
 * chain's base==prev-head invariant, read from the git truth. A fix that
 * landed BELOW the member moves that head while the base's NAME stays
 * the same — the name alone reads as "in sync", the head says otherwise,
 * and without this the operator rebases the chain by hand.
 *
 * `undefined` when a head cannot be read: an UNKNOWN truth is not
 * "carries" — the chain is not attested, and the caller skips the member
 * rather than claiming a success it cannot prove.
 */
function carriesBaseHead(branch: string, base: string, root: string): boolean | undefined {
  const baseHead = baseTip(root, base);
  return carriesCommit(branch, baseHead ?? '', root);
}

/** Does the branch still carry this COMMIT? The chain's base==prev-head
 *  invariant, read from the git truth — and the same question the fork
 *  asks: the fork is only the member's own work when the base's commit
 *  is inside the member's history. */
function carriesCommit(branch: string, baseHead: string, root: string): boolean | undefined {
  const memberHead = gitTry([
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]).out.trim();
  if (baseHead === '' || memberHead === '') {
    return undefined;
  }
  return gitTry(['-C', root, 'merge-base', '--is-ancestor', baseHead, memberHead]).code === 0;
}

/** The base's tip, read as a SHA. The ref's TIP — the commit the
 *  member's own work starts after — and a SHA does not move: the
 *  cascade rewrites the base's ref, and a name read after that points
 *  somewhere else.
 *
 *  ONE read, ONE answer: the containment check and the fork use the
 *  same commit, so the base cannot slip between the two reads. */
function baseTip(root: string, base: string): string | undefined {
  const ref = baseRef(root, base);
  if (ref === undefined) {
    return undefined;
  }
  const sha = gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).out.trim();
  return sha === '' ? undefined : sha;
}

/** The heads the plan reads — one flag per member. A merged member
 *  leaves the chain: the member above it stands on the one below the
 *  merged one, exactly as `planSync`'s own live tip walks.
 *
 *  The plan's FORK rides along: the base's tip as a SHA, read HERE —
 *  in the plan phase, before the cascade moves any ref. The rebase
 *  starts the member's replay from that commit, so the replay carries
 *  the member's own work and never the base's old commits. */
function markBaseHeads(members: MemberView[], root: string, defaultBase: string): void {
  let prev = defaultBase;
  for (const m of members) {
    if (m.prState !== 'MERGED') {
      const base = baseOf(m, prev);
      const tip = baseTip(root, base);
      m.forkSha = tip;
      // the containment check reads the SAME commit the fork will use —
      // one answer, so the base cannot slip between the two reads
      m.containsBaseHead = tip === undefined ? undefined : carriesCommit(m.branch, tip, root);
      prev = m.branch;
    }
  }
}

/**
 * The chain's ROOT base — the branch its first member stands on. A chain
 * that roots on something other than the default branch (the router's arc
 * roots on its own PR) must not be planned onto the default: the root is
 * the chain's own, and the plan follows it.
 *
 * A member that MERGED left the chain: its base is the branch it landed
 * on, and that branch is gone with it. The chain then stands on the
 * default branch — the same answer `planSync` gives the member that
 * follows ("its successor's base becomes the nearest lower member still
 * open, or the default branch").
 *
 * A DEAD ref is never a base. The recorded edge names a branch that may
 * itself have merged and been deleted (the arc's base merges before the
 * layer above it does) — planning onto it is what made the sync refuse
 * to move the members that were still in the chain. So the candidate
 * must be a branch that still EXISTS; otherwise the chain falls back to
 * the default branch, which is where the dead branch's work landed.
 *
 * `alive` answers "does this branch still exist" — the caller reads it
 * from the git truth, so this stays a pure function of its inputs. It is
 * REQUIRED, with no default: a caller that forgot to check would fail
 * OPEN (every dead branch reads as alive), which is the failure this
 * whole guard exists to prevent.
 *
 * `undefined` when NO branch is alive — not even the default branch.
 * There is nothing to stand on, and the caller must say so rather than
 * plan onto a dead ref.
 */
export function chainRootBase(
  members: SyncMemberInput[],
  defaultBase: string,
  alive: (branch: string) => boolean
): string | undefined {
  const first = members[0];
  if (first !== undefined && first.prState !== 'MERGED') {
    for (const candidate of [first.edgeBase, first.prBase]) {
      if (candidate !== undefined && alive(candidate)) return candidate;
    }
  }
  return alive(defaultBase) ? defaultBase : undefined;
}

/** Where the member's own work began — the commit its branch was
 *  created at, read from its OWN reflog ("branch: Created from <base>"
 *  names the base's tip of that moment). The base's ref may be GONE —
 *  the platform deletes a merged member's branch — and the member's
 *  history still remembers.
 *
 *  The CREATION entry, not merely the oldest one: a reflog that was
 *  truncated or expired has no creation entry left, and its oldest
 *  survivor is a later commit — a fork that would drop the member's own
 *  commits. No creation entry means no answer, and the caller falls
 *  through to the base's reflog. */
function forkFromReflog(branch: string, wt: string): string | undefined {
  const out = gitTry(['-C', wt, 'reflog', 'show', '--format=%H %gs', branch]).out;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [sha, ...rest] = trimmed.split(' ');
    if (!rest.join(' ').startsWith('branch: Created')) continue;
    return gitTry(['-C', wt, 'merge-base', '--is-ancestor', sha, 'HEAD']).code === 0
      ? sha
      : undefined;
  }
  return undefined;
}

/**
 * Where the child's own work starts — the fork point for a rebase onto a
 * base whose history moved. The plain merge-base is right when the child
 * was built on the base's CURRENT tip. When the base was REWRITTEN under
 * the child (a fix landed below and the parent was rebased), the
 * merge-base is the parent's old root and the replay would carry the
 * parent's old commits — and their conflicts — along.
 *
 * Three answers, in order of how well they know the truth:
 *
 * 1. the base's tip, already inside the child — the merge-base IS the
 *    fork: the child's work starts right after it.
 * 2. git's OWN fork point — the base's reflog remembers the tip the
 *    child was built on, so this is exact even when the rewrite changed
 *    the parent's CONTENT (an amend that adds a file is not patch-
 *    equivalent, and only the reflog still knows where the child began).
 * 3. the child's last commit the new base already holds BY PATCH — the
 *    rewritten parent looks patch-equivalent to git.
 *
 * And when none of the three answers — NO FORK. The bare merge-base is a
 * GUESS: it sits BEFORE the base's old commits, so a replay from there
 * carries them (and their conflicts) along. When no reflog and no
 * patch-equivalence can place the fork, the rebase does not happen and
 * the owner resolves it — a member that is skipped is visible, a member
 * that replays the base's commits is not.
 */
export function forkPoint(base: string, wt: string): string {
  // the base is read through the resolver (bro-yi9sz): a base that lives
  // only as a remote-tracking ref is a base, not a dead ref. An
  // unresolvable base keeps the old behaviour — the git calls below fail
  // and the caller sees no fork.
  const ref = baseRef(wt, base) ?? base;
  const mergeBase = gitTry(['-C', wt, 'merge-base', ref, 'HEAD']).out.trim();
  if (mergeBase === '') {
    return mergeBase;
  }
  // the base's tip is already inside the child — the merge-base IS the fork
  if (gitTry(['-C', wt, 'merge-base', '--is-ancestor', ref, 'HEAD']).code === 0) {
    return mergeBase;
  }
  // git's own answer — the base's reflog, not a guess
  const forked = gitTry(['-C', wt, 'merge-base', '--fork-point', ref, 'HEAD']).out.trim();
  if (forked !== '') {
    return forked;
  }
  const cherry = gitTry(['-C', wt, 'cherry', ref, 'HEAD']).out.trim();
  if (cherry === '') {
    // every commit the member carries is in the base by patch — there is
    // no work of its own to replay, and the fork is its own tip
    return gitTry(['-C', wt, 'rev-parse', 'HEAD']).out.trim();
  }
  let fork = '';
  for (const line of cherry.split('\n')) {
    // The cherry list runs OLDEST first: the equivalent commits the
    // child carries come before the child's own work. The fork is the
    // LAST equivalent before that work starts — a later equivalent
    // would push the fork past the child's own commits and drop them
    // from the replay.
    if (line.startsWith('+ ')) break;
    if (line.startsWith('- ')) {
      fork = line.slice(2).trim();
    }
  }
  return fork;
}

/** Where the member's replay must start — the fork, in the order of how
 *  well each answer knows the truth.
 *
 *  1. THE PLAN'S SHA — the base's tip as the plan saw it — but only
 *     while the member's CURRENT history still carries it: the member
 *     may have been rewritten since the plan (the platform's follow),
 *     and a commit the member does not carry is not a fork.
 *  2. THE BASE THE MEMBER FORKED FROM (`oldBase`) — the branch the
 *     member's line actually left, so `forkPoint` asks the right
 *     question: where was that base when the member branched off it.
 *     The BASE's reflog is the base's own history — the member's own
 *     branch moves cannot rewrite it, so a member that was deleted and
 *     recreated (a new creation entry, a later point) cannot fool it.
 *  3. THE MEMBER'S OWN CREATION POINT — the base's ref may be GONE (the
 *     platform deleted it after the merge), and the member's history
 *     still remembers where its work began.
 *  4. NOTHING — and that is an answer too. The desired base's reflog
 *     answers a DIFFERENT question (where the desired base forked from
 *     the member's line), and its answer is OLDER than the truth: it is
 *     where the chain left the trunk, so a replay from there carries
 *     the base's old commits. No fork, no rebase: the owner resolves
 *     it. */
export function forkFor(
  branch: string,
  forkSha: string | undefined,
  oldBase: string,
  wt: string
): string {
  if (forkSha !== undefined && carriesCommit(branch, forkSha, wt) === true) {
    return forkSha;
  }
  const fromBase = forkPoint(oldBase, wt);
  if (fromBase !== '') {
    return fromBase;
  }
  const own = forkFromReflog(branch, wt);
  if (own !== undefined) {
    return own;
  }
  return '';
}

/** Rebase a member's branch onto its new base and force-push the result
 *  when a PR rides it. The fork point is the base's tip AS THE PLAN SAW
 *  IT — a SHA captured before the cascade moved any ref. A branch name
 *  read here would be the base's NEW tip, and git would fall back to
 *  the merge-base: too old, and the parent's old commits ride along as
 *  add/add conflicts. */
function rebaseMember(item: SyncPlanItem<MemberView>, lines: string[]): boolean {
  const m = item.member;
  const wt = m.worktree!;
  const fork = forkFor(m.branch, m.forkSha, item.oldBase, wt.path);
  if (fork === '') {
    // No verified fork: the plan's SHA is not carried, the base's reflog
    // cannot place the fork, and the member's own cannot either. A guess
    // here would replay the base's old commits — so the member is left
    // alone and its owner is told.
    lines.push(
      `  ${m.branch} skipped — the fork could not be established (the base's reflog is gone and the member's own does not answer); owner resolves on enter`
    );
    return false;
  }
  // A plain rebase LINEARIZES: the merge commits in the replayed range
  // are dropped, and with them the conflict resolutions they carry. The
  // member comes out rewritten and the sync says "rebased" — the
  // content is gone. Same corruption class as `stack merge --rebase`,
  // which refuses it (bro-dz0u9, PR #872) — the same counter, the same
  // wording. The tip is PINNED: `m.branch` is a moving ref, and the
  // count, the range and the rebase must speak about the same commits.
  const head = gitTry(['-C', wt.path, 'rev-parse', '--verify', '--quiet', m.branch]).out.trim();
  if (head === '') {
    lines.push(`  ${m.branch} skipped — its tip cannot be read; owner resolves on enter`);
    return false;
  }
  const merges = countMergesInRange(wt.path, `${fork}..${head}`);
  if (merges === undefined || merges > 0) {
    lines.push(
      merges === undefined
        ? `  ${m.branch} skipped — the merge commits in its range cannot be counted; owner resolves on enter`
        : `  ${m.branch} contains merge commits — a rebase cannot preserve merge resolutions; use merge or squash`
    );
    return false;
  }
  const rb = gitTry(['-C', wt.path, 'rebase', '--onto', ontoBase(wt.path, item.desiredBase), fork]);
  if (rb.code !== 0) {
    gitTry(['-C', wt.path, 'rebase', '--abort']);
    lines.push(
      `  ${m.branch} rebase onto ${item.desiredBase} failed — aborted; owner resolves on enter`
    );
    return false;
  }
  lines.push(`  ${m.branch} rebased onto ${item.desiredBase}`);
  if (m.pr === undefined) {
    return true;
  }
  // a rebased branch with an open PR must move the remote head too —
  // retargeting while the remote still carries pre-rebase commits
  // would inflate the PR diff
  const push = gitTry([
    '-C',
    wt.path,
    'push',
    '--force-with-lease',
    'origin',
    `HEAD:refs/heads/${m.branch}`,
  ]);
  if (push.code !== 0) {
    lines.push(`  ${m.branch} push failed — ${push.err || 'remote refused'}; retarget skipped`);
    return false;
  }
  return true;
}

/** Move the member's recorded edge to its new base — the edge is the
 *  fork truth, so it updates even when the PR retarget is refused (a
 *  stale edge would re-schedule the rewrite on every later sync). */
function updateEdge(m: MemberView, desiredBase: string, trunk: string): void {
  if (desiredBase === trunk) {
    removeStackEdge(m.branch);
  } else {
    recordStackEdge(m.branch, desiredBase);
  }
}

/** Retarget the member's PR to its new base. False when the move was
 *  owed and didn't land — a refused retarget or a host without
 *  retargetPr leaves the chain's base==prev-head invariant broken, and
 *  the caller defers the publish tail rather than feeding it to the
 *  host's stack tool. */
function retargetMember(
  item: SyncPlanItem<MemberView>,
  rev: { repo: string; facade: ReviewFacade } | undefined,
  lines: string[]
): boolean {
  const m = item.member;
  if (!item.retarget || m.pr === undefined) {
    return true;
  }
  if (rev?.facade.retargetPr === undefined) {
    lines.push(`  ${m.branch} — review host cannot retarget PRs; set --base by hand`);
    return false;
  }
  const ok = rev.facade.retargetPr({ repo: rev.repo, pr: m.pr }, item.desiredBase);
  lines.push(
    ok
      ? `  ${rev.facade.prLink(rev.repo, m.pr)} retargeted → ${item.desiredBase}`
      : `  ${rev.facade.prLink(rev.repo, m.pr)} retarget refused`
  );
  return ok;
}

/** A merge the platform performed moved the remote branch and
 *  retargeted the PR, but this member's worktree still sits on the old
 *  commits — fetch and rebase onto FETCH_HEAD. The platform replayed
 *  the branch's own commits server-side, so patch-equivalence drops
 *  them from the replay and only work never pushed lands on top —
 *  never a reset that would silently discard it. A failed fetch means
 *  the remote branch is gone (or unreachable): keep the worktree.
 *  Returns false when the follow didn't complete — the caller leaves
 *  the edge stale so the next sync reschedules the work. */
function followRemote(m: MemberView, lines: string[]): boolean {
  const wt = m.worktree!;
  const probe = gitTry(['-C', wt.path, 'fetch', 'origin', m.branch]);
  if (probe.code !== 0) {
    lines.push(`  ${m.branch} remote gone — worktree left as-is`);
    return false;
  }
  const before = gitTry(['-C', wt.path, 'rev-parse', 'HEAD']).out.trim();
  const rb = gitTry(['-C', wt.path, 'rebase', 'FETCH_HEAD']);
  if (rb.code !== 0) {
    gitTry(['-C', wt.path, 'rebase', '--abort']);
    lines.push(
      `  ${m.branch} rebase onto the rewritten remote failed — aborted; owner resolves on enter`
    );
    return false;
  }
  const after = gitTry(['-C', wt.path, 'rev-parse', 'HEAD']).out.trim();
  lines.push(
    before === after
      ? `  ${m.branch} already on the rewritten remote`
      : `  ${m.branch} moved to origin/${m.branch} (platform rewrote the remote)`
  );
  return true;
}

/** What publish settled into — 'skipped' is the benign quiet path
 *  (fewer than two open PRs, nothing attempted): the sync caller must
 *  not read it as a failure. Only 'failed' propagates — a split
 *  refusal, a thrown link, or an unproven membership readback. */
type PublishOutcome = 'registered' | 'skipped' | 'failed';

/** Membership probe ahead of publish — 'registered' when every open
 *  member already sits in one host stack (a re-run is a no-op),
 *  'refused' when the chain is split across two stacks (the tool would
 *  reject; say so first), 'unproven' when publish still has to run. */
function membershipPreflight(
  name: string,
  open: MemberView[],
  membership: NonNullable<StackFacade['membership']>,
  lines: string[],
  quiet: boolean
): 'registered' | 'refused' | 'unproven' {
  const ids = new Set<number>();
  let unstacked = 0;
  for (const m of open) {
    const hit = membership(m);
    if (hit === null) {
      unstacked++;
    } else {
      ids.add(hit.id);
    }
  }
  if (ids.size > 1) {
    const list = [...ids].map(i => `#${i}`).join(', ');
    lines.push(`  stack ${name}: members sit in different host stacks (${list}) — split by hand`);
    return 'refused';
  }
  if (ids.size === 1 && unstacked === 0) {
    if (!quiet) {
      lines.push(`  stack ${name} already published — stack #${[...ids][0]!}`);
    }
    return 'registered';
  }
  return 'unproven';
}

/** Register the chain's open member PRs as the host's stack object —
 *  `gh stack link` on GitHub, absent everywhere chains are detected
 *  from the base links themselves. `quiet` is the cascade caller:
 *  benign no-ops (<2 open PRs, already registered) print nothing — a
 *  refusal still does, it's real signal about the chain. 'registered'
 *  means the members ended up in a stack — the post-publish membership
 *  readback is the success proof, so an empty one fails, not passes. */
function publishStack(
  name: string,
  members: MemberView[],
  stacks: StackFacade,
  defaultBase: string,
  lines: string[],
  quiet: boolean
): PublishOutcome {
  const open = members.filter(m => m.pr !== undefined && m.prState === 'OPEN');
  if (open.length < 2) {
    if (!quiet) {
      lines.push(`  stack ${name}: fewer than two open member PRs — nothing to publish`);
    }
    return 'skipped';
  }
  if (stacks.membership !== undefined) {
    const pre = membershipPreflight(name, open, stacks.membership, lines, quiet);
    if (pre === 'refused') {
      return 'failed';
    }
    if (pre === 'registered') {
      return 'registered';
    }
  }
  const chain: StackChainMember[] = open.map(m => ({
    branch: m.branch,
    base: displayBase(m, defaultBase),
    pr: m.pr,
    headSha: m.headSha,
  }));
  try {
    const hit = stacks.publish?.(chain);
    if (hit === null || hit === undefined) {
      lines.push(`  stack ${name} publish failed — host reported no membership`);
      return 'failed';
    }
    lines.push(`  stack ${name} published — stack #${hit.id}`);
    return 'registered';
  } catch (err) {
    lines.push(`  stack ${name} publish failed — ${(err as Error).message}`);
    return 'failed';
  }
}

/** `bro stack publish [<name>]` — the post-hoc verb: member PRs are
 *  opened by workers after `stack push`, so registering the chain can
 *  only run once ≥2 exist. Resolves the chain's name like merge does
 *  (positional, --name, or the member worktree's own branch). */
function cmdPublish(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS);
  const name =
    flag(argv, '--name') ??
    pos[0] ??
    parseStackBranch(gitTry(['branch', '--show-current']).out.trim())?.name;
  if (name === undefined || !isStackName(name)) {
    console.error('error: no stack context — pass a name or run inside a member worktree');
    usage();
  }
  const main = mainWorktree();
  const stacks = resolveStacks(main.path);
  if (stacks?.publish === undefined) {
    console.error(
      'error: no connector serves stack publish — GitLab detects chains from base branches itself, plain git has no host'
    );
    process.exitCode = 1;
    return;
  }
  const rev = resolveReview(main.path);
  const defaultBase = defaultBranchName() ?? main.branch ?? 'main';
  const members = collectMembers(name, main.path, rev);
  if (members.length === 0) {
    console.log(`stack ${name} has no members — nothing to publish`);
    return;
  }
  const lines: string[] = [];
  if (publishStack(name, members, stacks, defaultBase, lines, false) !== 'registered') {
    process.exitCode = 1;
  }
  for (const l of lines) {
    console.log(l);
  }
}

/** Per-member cascade context — the inputs every sync step reads. */
interface SyncCtx {
  root: string;
  rev: { repo: string; facade: ReviewFacade } | undefined;
  stacks: StackFacade | undefined;
  /** The repo's DEFAULT branch — a member's edge goes only when the
   *  member stands on it. The chain's own root is a different branch,
   *  and its edge is the root the chain is built on. */
  trunk: string;
  /** The base the plan targets — the chain's own root. */
  defaultBase: string;
  lines: string[];
}

/** The rebase half of a member's cascade step — a platform-rewritten
 *  remote gets a fetch+rebase follow, everything else a local rebase
 *  onto the new base. No rebase owed is a pass. */
function rebaseStep(
  item: SyncPlanItem<MemberView>,
  cascade: StackCascade,
  lines: string[]
): boolean {
  if (!item.rebase) {
    return true;
  }
  if (cascade.rebase) {
    return followRemote(item.member, lines);
  }
  return rebaseMember(item, lines);
}

/** How a member's cascade step ended — 'rebased' means its branch was
 *  rewritten, so the member ABOVE it rides a base that moved. */
type SyncOutcome = 'ok' | 'rebased' | 'failed';

/** The invariant's verdict BEFORE the move: 'ok' when the branch may
 *  move, 'failed' when the base's head cannot be read or the member is
 *  skipped. The plan was made BEFORE the cascade ran, so it cannot
 *  know whether the base's head moved — the branch must carry the head
 *  of the base it stands on, and that is read here. */
function baseVerdict(m: MemberView, item: SyncPlanItem<MemberView>, ctx: SyncCtx): 'ok' | 'failed' {
  const carries = carriesBaseHead(m.branch, item.desiredBase, ctx.root);
  if (carries === undefined) {
    // an unknown head is not a success — the chain is not attested
    ctx.lines.push(`  ${m.branch} skipped — the head of ${item.desiredBase} cannot be read`);
    return 'failed';
  }
  if (!carries) {
    item.rebase = true;
    if (!m.rebaseable) {
      item.skip = m.blocked ?? 'not rebaseable';
    }
  }
  if (item.skip) {
    ctx.lines.push(`  ${m.branch} skipped — ${item.skip}`);
    return 'failed';
  }
  return 'ok';
}

/** The base's head AFTER the move: the platform rewrites a child when
 *  its parent MERGES — but a base that moved by a PUSH is not a merge,
 *  and the platform leaves the child where it was. The invariant
 *  decides, not the assumption. */
function settleBase(item: SyncPlanItem<MemberView>, m: MemberView, ctx: SyncCtx): SyncOutcome {
  if (carriesBaseHead(m.branch, item.desiredBase, ctx.root) === false) {
    if (!rebaseMember(item, ctx.lines)) {
      return 'failed';
    }
    return 'rebased';
  }
  return item.rebase ? 'rebased' : 'ok';
}

/** The cascade this member's connector owns — the default when the
 *  connector has no opinion (a plain rebase, no platform rewrite). */
function cascadeFor(m: MemberView, ctx: SyncCtx): StackCascade {
  return ctx.stacks?.cascade?.(m) ?? MANUAL_CASCADE;
}

/** The move's own phase: the branch is rewritten, the edge moves, and
 *  the PR is retargeted — by the platform when it owns the chain, by
 *  bro otherwise. */
function moveMember(item: SyncPlanItem<MemberView>, m: MemberView, ctx: SyncCtx): SyncOutcome {
  const cascade = cascadeFor(m, ctx);
  // The edge is the fork truth planSync reads — it moves only after
  // the member's local work landed. Recording it before a rebase or
  // remote-follow would read a failed rewrite as synced and never
  // reschedule it.
  if (!rebaseStep(item, cascade, ctx.lines)) {
    return 'failed';
  }
  const moved = settleBase(item, m, ctx);
  if (moved === 'failed') {
    return 'failed';
  }
  updateEdge(m, item.desiredBase, ctx.trunk);
  if (!cascade.retarget) {
    return retargetMember(item, ctx.rev, ctx.lines) ? moved : 'failed';
  }
  if (item.retarget && m.pr !== undefined) {
    ctx.lines.push(`  ${m.branch} PR retarget → ${item.desiredBase} (platform)`);
  }
  return moved;
}

/** One member's cascade step. 'failed' when the chain's base==prev-head
 *  invariant broke (a dirty member, a failed move) — the caller drops
 *  the publish tail instead of feeding the host's stack tool a
 *  reject. */
function syncMember(item: SyncPlanItem<MemberView>, ctx: SyncCtx): SyncOutcome {
  const m = item.member;
  if (m.prState === 'MERGED') {
    retireMerged(m, ctx.root, ctx.lines);
    return 'ok';
  }
  const preflight = baseVerdict(m, item, ctx);
  if (preflight !== 'ok') {
    return preflight;
  }
  if (!item.rebase && !item.retarget) {
    return 'ok'; // in sync — don't even touch the edge file
  }
  return moveMember(item, m, ctx);
}

/** The sync cascade — shared by `stack sync` and `loop --stack`'s
 *  post-merge step. Per-member cascade ownership comes from the
 *  connector's stacks facade: when the platform already retargeted the
 *  PR (GitLab stacked MRs, GitHub .stack members) the API call is
 *  skipped, and when it also rewrote the remote branch (GitHub) the
 *  local worktree fast-follows instead of rebasing. Returns the
 *  per-member report lines; never throws on a single member's failure
 *  (a conflict stops that member, not the run). `status` is the
 *  optional out-channel: a failed auto-publish (the chain was
 *  publishable but the host refused or couldn't prove membership)
 *  flags `publishFailed` so `stack sync` can exit nonzero — a benign
 *  skip (<2 open PRs, deferred on a broken cascade) never does. */
export function syncStack(
  root: string,
  name: string,
  status?: { publishFailed: boolean }
): string[] {
  const main = mainWorktree();
  const trunk = defaultBranchName() ?? main.branch ?? 'main';
  const ctx: SyncCtx = {
    root,
    rev: resolveReview(root),
    stacks: resolveStacks(root),
    trunk,
    defaultBase: trunk,
    lines: [],
  };
  const members = collectMembers(name, root, ctx.rev);
  // a branch that no longer exists cannot carry the chain — the git truth
  // decides, so the root falls back to the default branch
  const chainRoot =
    chainRootBase(members, ctx.trunk, b => localBranch(root, b)) ??
    // the default branch may live ONLY as a remote-tracking ref
    // (bro-yi9sz): a checkout that never created it locally still has a
    // base to stand on. A member's own edge base keeps the local-only
    // rule above — a deleted branch must not be resurrected by a stale,
    // unpruned tracking ref.
    (baseRef(root, ctx.trunk) !== undefined ? ctx.trunk : undefined);
  if (chainRoot === undefined) {
    // not even the default branch exists locally: there is nothing to
    // stand on, and planning onto a dead ref is what this guard is for
    ctx.lines.push(
      `  ${name} — the chain's root ${ctx.trunk} does not exist; nothing to sync onto`
    );
    return ctx.lines;
  }
  ctx.defaultBase = chainRoot;
  markBaseHeads(members, root, ctx.defaultBase);
  // A clean cascade — nothing skipped, nothing refused — leaves the
  // chain's base==prev-head invariant proven, which is exactly what the
  // host's stack registration demands. A dirty member or a failed move
  // breaks it: defer publish instead of feeding the tool a reject.
  let intact = true;
  const plan = planSync(members, ctx.defaultBase);
  for (const item of plan) {
    const outcome = syncMember(item, ctx);
    if (outcome === 'failed') {
      intact = false;
    }
  }
  const stacks = ctx.stacks;
  if (intact && stacks?.publish !== undefined) {
    const outcome = publishStack(name, members, stacks, ctx.defaultBase, ctx.lines, true);
    if (outcome === 'failed' && status !== undefined) {
      status.publishFailed = true;
    }
  }
  return ctx.lines;
}

function cmdSync(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS);
  const main = mainWorktree();
  const names = pos[0] ? [pos[0]] : stackNames(allBranches(main.path));
  if (names.length === 0) {
    console.log('no stacks — nothing to sync');
    return;
  }
  for (const name of names) {
    console.log(`stack ${name}:`);
    const status = { publishFailed: false };
    const lines = syncStack(main.path, name, status);
    if (lines.length === 0) {
      console.log('  in sync');
    } else {
      for (const l of lines) {
        console.log(l);
      }
    }
    if (status.publishFailed) {
      process.exitCode = 1;
    }
  }
}

const MERGE_BOOL_FLAGS = new Set(['--squash', '--merge', '--rebase', '--admin']);

/** `bro stack merge` — land the chain bottom→top through the
 *  connector's own mechanism: `gh stack merge` where the extension
 *  answers, bottom-up `PUT …/merge` on GitLab (the platform retargets
 *  between layers), the same per-layer drive on a bare GitHub remote,
 *  plain `git merge` forge-less. Every OPEN member's review gate is
 *  evaluated BEFORE the first merge call — refusing early keeps even
 *  the per-layer fallback effectively all-or-nothing on the gate axis. */
async function cmdMerge(argv: string[]): Promise<void> {
  const pos = positionals(argv, NAME_FLAGS, { boolFlags: MERGE_BOOL_FLAGS, strict: true });
  const name =
    flag(argv, '--name') ??
    pos[0] ??
    parseStackBranch(gitTry(['branch', '--show-current']).out.trim())?.name;
  if (name === undefined || !isStackName(name)) {
    console.error('error: no stack context — pass a name or run inside a member worktree');
    usage();
  }
  const picked = (['--squash', '--merge', '--rebase'] as const).filter(f => argv.includes(f));
  if (picked.length > 1) {
    console.error(`error: ${picked.join(' ')} — merge strategy flags are exclusive`);
    usage();
  }
  const opts: StackMergeOpts = {
    method: (picked[0]?.slice(2) ?? 'squash') as StackMergeOpts['method'],
    admin: argv.includes('--admin'),
  };
  const main = mainWorktree();
  const trunk = defaultBranchName() ?? main.branch ?? 'main';
  const rev = resolveReview(main.path);
  const stacks = resolveStacks(main.path);
  const members = collectMembers(name, main.path, rev);
  if (members.length === 0) {
    console.log(`stack ${name} has no members — nothing to merge`);
    return;
  }
  const live = members.filter(m => m.prState !== 'MERGED');
  if (live.length === 0) {
    console.log('nothing to merge — every member already landed');
    return;
  }
  // The merge set is the contiguous prefix that CAN land — on a review
  // host that means an OPEN PR per member, so a PR-less or closed member
  // breaks the chain (nothing merges past it). Forge-less, every member
  // is mergeable: git lands the whole chain.
  let mergeable = live;
  if (rev !== undefined) {
    const cut = live.findIndex(m => m.pr === undefined || m.prState !== 'OPEN');
    mergeable = cut === -1 ? live : live.slice(0, cut);
    if (mergeable.length === 0) {
      console.error(
        `error: bottom member ${live[0]!.branch} has no OPEN PR — nothing can merge past it`
      );
      process.exitCode = 1;
      return;
    }
    if (mergeable.length < live.length) {
      console.log(`  ${live[mergeable.length]!.branch} has no OPEN PR — merge stops below it`);
    }
  } else if (stacks?.mergeChain === undefined) {
    console.error('error: no merge path — no review host and no stacks connector serve this repo');
    process.exitCode = 1;
    return;
  }

  // gate evaluation → merge is one critical section, same as act merge —
  // the slot wraps the checks themselves: taken after them, another merge
  // could move a PR between its gate read and its landing
  const slot = acquireMergeSlot();
  if (slot.kind === 'held') {
    console.error(
      `merge slot held by ${slot.holder} — another session is merging; ` +
        'wait for `bd merge-slot check` to report available'
    );
    process.exitCode = 1;
    return;
  }
  try {
    // gate every mergeable layer before the first merge — an unresolved
    // thread three layers up must not leave the bottom two landed
    if (rev !== undefined) {
      const act = loadBroConfig(main.path).act;
      for (const m of mergeable) {
        const pr = m.pr;
        if (pr === undefined) {
          continue; // unreachable — the prefix guarantees an OPEN PR
        }
        const state = await fetchPrActState(
          rev.facade,
          { repo: rev.repo, pr },
          {
            ignoreChecks: act.ignoreChecks,
            checkHistory: checkHistory(main.path),
            maxRounds: act.maxRounds,
            docsPaths: act.docsPaths,
            docsMaxRounds: act.docsMaxRounds,
            requireApproval: act.requireApproval,
            approvers: act.approvers,
            resolveLedger: resolveLedger(main.path),
          }
        );
        const gate = evaluateExitGate(state, { requireApproval: act.requireApproval });
        if (!gate.ok) {
          console.error(
            `exit_gate=BLOCKED — refusing to merge; ${rev.facade.prLink(rev.repo, pr)} (${m.branch}) is not ready:`
          );
          for (const b of gate.blockers) {
            console.error(`  blocker: ${b}`);
          }
          process.exitCode = 1;
          return;
        }
      }
    }
    const chain: StackChainMember[] = mergeable.map(m => ({
      branch: m.branch,
      base: trunk,
      pr: m.pr,
      headSha: m.headSha,
    }));
    const report =
      stacks?.mergeChain?.(chain, opts) ??
      (rev !== undefined
        ? mergeChainPerLayer(
            rev.facade,
            rev.repo,
            chain,
            opts,
            m => stacks?.cascade?.(m) ?? MANUAL_CASCADE
          )
        : undefined);
    if (report === undefined) {
      // a stacks facade that declined and no reviews facade to fall
      // back on — git-only connectors always carry mergeChain, so this
      // is the no-connector corner
      console.error('error: stack merge declined — no connector can merge this chain');
      process.exitCode = 1;
      return;
    }
    for (const l of report.lines) {
      console.log(l);
    }
    // a PR-less member that landed is invisible to sync's MERGED
    // detection — retire it here; members with reviews retire inside
    // the sync pass their host reports
    const mergedSet = new Set(report.merged);
    for (const m of mergeable) {
      if (mergedSet.has(m.branch) && m.pr === undefined) {
        const retireLines: string[] = [];
        retireMerged(m, main.path, retireLines);
        for (const l of retireLines) {
          console.log(l);
        }
      }
    }
    // the post-merge cascade: forge-merged retirement, retargets,
    // rebases — same pass `bro stack sync` runs
    for (const l of syncStack(main.path, name)) {
      console.log(l);
    }
  } finally {
    if (slot.kind === 'acquired') {
      releaseMergeSlot();
    }
  }
}

export async function runStackCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h' || hasHelpFlag(rest)) {
    usage(0);
  }
  switch (sub) {
    case 'push':
      return cmdPush(rest);
    case 'list':
      return cmdList(rest);
    case 'sync':
      return cmdSync(rest);
    case 'publish':
      return cmdPublish(rest);
    case 'merge':
      return cmdMerge(rest);
    default:
      usage();
  }
}
