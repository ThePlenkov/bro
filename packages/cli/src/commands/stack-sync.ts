/**
 * `bro stack sync` — the post-merge cascade. After a member lands the
 * chain's base==prev-head invariant is re-proven member by member:
 * merged members retire, owed retargets move, rebaseable branches
 * replay onto their new base, and only a fully clean pass registers
 * the chain with the host. Per-member cascade ownership comes from the
 * connector's stacks facade — where the platform already retargeted
 * the PR (GitLab stacked MRs, GitHub .stack members) the API call is
 * skipped, and where it also rewrote the remote branch the local
 * worktree fast-follows instead of rebasing.
 */

import type { ReviewFacade, StackCascade, StackFacade } from '@broject/core';
import { gitTry, MANUAL_CASCADE } from '@broject/core';
import type { SyncPlanItem } from '@broject/stack';
import { planSync, stackNames } from '@broject/stack';
import { positionals } from './args.ts';
import { NAME_FLAGS, printLines } from './stack-args.ts';
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
  ontoBase,
  resolveReview,
  resolveStacks,
} from './stack-refs.ts';
import { publishStack } from './stack-register.ts';
import { defaultBranchName, mainWorktree, recordStackEdge, removeStackEdge } from './work.ts';

/** A merged member leaves the chain — its edge goes, and its branch
 *  goes too when no worktree still holds it (a checked-out branch can't
 *  be deleted; the owner's worktree keeps it until `work leave`). */
export function retireMerged(m: MemberView, root: string, lines: string[]): void {
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
export interface SyncCtx {
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
export type SyncOutcome = 'ok' | 'rebased' | 'failed';

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
 *  decides, not the assumption. A head that cannot be READ is the
 *  preflight's answer too: an unknown truth is not "carries" — the
 *  member fails, its edge stays stale so the next sync reschedules,
 *  and the publish tail is dropped rather than attesting a chain the
 *  invariant cannot prove. */
export function settleBase(
  item: SyncPlanItem<MemberView>,
  m: MemberView,
  ctx: SyncCtx
): SyncOutcome {
  const carries = carriesBaseHead(m.branch, item.desiredBase, ctx.root);
  if (carries === undefined) {
    ctx.lines.push(`  ${m.branch} skipped — the head of ${item.desiredBase} cannot be read`);
    return 'failed';
  }
  if (!carries) {
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

/** The auto-publish tail. A clean cascade — nothing skipped, nothing
 *  refused — leaves the chain's base==prev-head invariant proven,
 *  which is exactly what the host's stack registration demands. A
 *  dirty member or a failed move breaks it: defer publish instead of
 *  feeding the tool a reject. A failed publish flags `publishFailed`
 *  so `stack sync` exits nonzero — a benign skip (<2 open PRs) never
 *  does. */
function autoPublish(
  ctx: SyncCtx,
  name: string,
  members: MemberView[],
  verdict: { intact: boolean; status?: { publishFailed: boolean } }
): void {
  const stacks = ctx.stacks;
  if (!verdict.intact || stacks?.publish === undefined) {
    return;
  }
  const outcome = publishStack(name, members, stacks, ctx.defaultBase, ctx.lines, true);
  if (outcome === 'failed' && verdict.status !== undefined) {
    verdict.status.publishFailed = true;
  }
}

/** The sync cascade — shared by `stack sync` and `loop --stack`'s
 *  post-merge step. Returns the per-member report lines; never throws
 *  on a single member's failure (a conflict stops that member, not the
 *  run). `status` is the optional out-channel: a failed auto-publish
 *  (the chain was publishable but the host refused or couldn't prove
 *  membership) flags `publishFailed` so `stack sync` can exit nonzero —
 *  a benign skip (<2 open PRs, deferred on a broken cascade) never
 *  does. */
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
  let intact = true;
  const plan = planSync(members, ctx.defaultBase);
  for (const item of plan) {
    if (syncMember(item, ctx) === 'failed') {
      intact = false;
    }
  }
  autoPublish(ctx, name, members, { intact, status });
  return ctx.lines;
}

/** One stack's sync report — 'in sync' when the pass printed nothing,
 *  the collected member lines otherwise. */
function reportSync(root: string, name: string, status: { publishFailed: boolean }): void {
  const lines = syncStack(root, name, status);
  if (lines.length === 0) {
    console.log('  in sync');
    return;
  }
  printLines(lines);
}

export function cmdSync(argv: string[]): void {
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
    reportSync(main.path, name, status);
    if (status.publishFailed) {
      process.exitCode = 1;
    }
  }
}
