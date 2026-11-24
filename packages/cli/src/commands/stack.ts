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
  acquireMergeSlot,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  releaseMergeSlot,
  resolveLedger,
} from '@broject/act';
import {
  acquireFileLock,
  gitTry,
  hasHelpFlag,
  LockTimeout,
  MANUAL_CASCADE,
  mergeChainPerLayer,
  type ReviewFacade,
  type StackCascade,
  type StackChainMember,
  type StackFacade,
  type StackMergeOpts,
  shQuote,
} from '@broject/core';
import {
  displayBase,
  formatStackBranch,
  isStackName,
  planSync,
  type SyncPlanItem,
  stackNames,
} from '@broject/stack';
import { loadBroConfig } from '../plugins.ts';
import { positionals } from './args.ts';
import {
  MERGE_BOOL_FLAGS,
  NAME_FLAGS,
  requiredStackName,
  resolveStackName,
  usage,
} from './stack-args.ts';
import {
  carriesBaseHead,
  chainRootBase,
  forkFor,
  markBaseHeads,
  mergeCommitRefusal,
} from './stack-fork.ts';
import type { MemberView } from './stack-refs.ts';
import {
  allBranches,
  baseRef,
  collectMembers,
  localBranch,
  mergedBranches,
  ontoBase,
  resolveReview,
  resolveStacks,
  stackMemberFor,
  stackTip,
} from './stack-refs.ts';
import { cmdPublish, publishStack } from './stack-register.ts';
import {
  createWorktree,
  defaultBranchName,
  type EnterWorktreeResult,
  finishWorktreeEnter,
  mainWorktree,
  readStackEdges,
  recordStackEdge,
  removeStackEdge,
  stackPushLockPath,
  stateOfWorktree,
  type WorktreeCreateResult,
} from './work.ts';

export { chainRootBase, forkFor, forkPoint } from './stack-fork.ts';
export type { MemberView } from './stack-refs.ts';
export {
  baseRef,
  mergedBranches,
  stackMemberFor,
  stackTip,
} from './stack-refs.ts';

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
  // wording.
  //
  // The tip is read ONCE and pins everything downstream: the counted
  // range is `fork..head`, the replay is exactly that range, and the
  // branch moves by compare-and-swap against that same `head`. A branch
  // that moved meanwhile fails the swap — the tip is never re-read, so
  // the range and the replay can never speak about different commits.
  const head = gitTry([
    '-C',
    wt.path,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${m.branch}`,
  ]).out.trim();
  if (head === '') {
    lines.push(`  ${m.branch} skipped — its tip cannot be read; owner resolves on enter`);
    return false;
  }
  const refusal = mergeCommitRefusal(wt.path, `${fork}..${head}`, m.branch);
  if (refusal !== undefined) {
    lines.push(refusal);
    return false;
  }
  // The replay is PINNED to the counted commits: `git rebase --onto <base>
  // <fork> <head>` replays exactly `fork..head` and leaves the branch ref
  // alone (detached HEAD). Nothing that lands after the count can be
  // replayed uncounted. The branch then moves by COMPARE-AND-SWAP: if it
  // moved since the count — the owner committed meanwhile — the swap
  // fails and the branch is left exactly as the owner left it. A member
  // whose history changed under the sync is reported, never rewritten.
  const rb = gitTry([
    '-C',
    wt.path,
    'rebase',
    '--onto',
    ontoBase(wt.path, item.desiredBase),
    fork,
    head,
  ]);
  if (rb.code !== 0) {
    gitTry(['-C', wt.path, 'rebase', '--abort']);
    lines.push(
      `  ${m.branch} rebase onto ${item.desiredBase} failed — aborted; owner resolves on enter`
    );
    return false;
  }
  const replayed = gitTry(['-C', wt.path, 'rev-parse', '--verify', '--quiet', 'HEAD']).out.trim();
  const swap = gitTry(['-C', wt.path, 'update-ref', `refs/heads/${m.branch}`, replayed, head]);
  if (swap.code !== 0) {
    // the branch moved while the replay ran — put the worktree back on it
    gitTry(['-C', wt.path, 'checkout', m.branch]);
    lines.push(
      `  ${m.branch} moved during the rebase (${head.slice(0, 7)} was not the tip anymore) — not rebased; re-run to land the new tip`
    );
    return false;
  }
  gitTry(['-C', wt.path, 'checkout', m.branch]);
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
  const before = gitTry([
    '-C',
    wt.path,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${m.branch}`,
  ]).out.trim();
  // the platform's rewrite is a rebase too: the range it replays must be
  // free of merge commits, or their resolutions are dropped (bro-dz0u9)
  const fork = gitTry(['-C', wt.path, 'merge-base', 'FETCH_HEAD', 'HEAD']).out.trim();
  if (fork === '' || before === '') {
    lines.push(
      `  ${m.branch} skipped — the rewritten remote's fork cannot be read; owner resolves on enter`
    );
    return false;
  }
  const refusal = mergeCommitRefusal(wt.path, `${fork}..${before}`, m.branch);
  if (refusal !== undefined) {
    lines.push(refusal);
    return false;
  }
  // the replay is PINNED to the counted commits (the same shape as the
  // local rebase): `git rebase --onto FETCH_HEAD <fork> <before>` replays
  // exactly `fork..before` and leaves the branch ref alone, so nothing
  // that lands after the count is replayed uncounted
  const rb = gitTry(['-C', wt.path, 'rebase', '--onto', 'FETCH_HEAD', fork, before]);
  if (rb.code !== 0) {
    gitTry(['-C', wt.path, 'rebase', '--abort']);
    lines.push(
      `  ${m.branch} rebase onto the rewritten remote failed — aborted; owner resolves on enter`
    );
    return false;
  }
  const after = gitTry(['-C', wt.path, 'rev-parse', 'HEAD']).out.trim();
  // the branch moves by compare-and-swap: a branch that moved while the
  // replay ran is left exactly as its owner left it
  const swap = gitTry(['-C', wt.path, 'update-ref', `refs/heads/${m.branch}`, after, before]);
  if (swap.code !== 0) {
    gitTry(['-C', wt.path, 'checkout', m.branch]);
    lines.push(
      `  ${m.branch} moved during the follow (${before.slice(0, 7)} was not the tip anymore) — not rebased; re-run to land the new tip`
    );
    return false;
  }
  gitTry(['-C', wt.path, 'checkout', m.branch]);
  lines.push(
    before === after
      ? `  ${m.branch} already on the rewritten remote`
      : `  ${m.branch} moved to origin/${m.branch} (platform rewrote the remote)`
  );
  return true;
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

/** `bro stack merge` — land the chain bottom→top through the
 *  connector's own mechanism: `gh stack merge` where the extension
 *  answers, bottom-up `PUT …/merge` on GitLab (the platform retargets
 *  between layers), the same per-layer drive on a bare GitHub remote,
 *  plain `git merge` forge-less. Every OPEN member's review gate is
 *  evaluated BEFORE the first merge call — refusing early keeps even
 *  the per-layer fallback effectively all-or-nothing on the gate axis. */
async function cmdMerge(argv: string[]): Promise<void> {
  const pos = positionals(argv, NAME_FLAGS, { boolFlags: MERGE_BOOL_FLAGS, strict: true });
  const name = requiredStackName(argv, pos);
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
