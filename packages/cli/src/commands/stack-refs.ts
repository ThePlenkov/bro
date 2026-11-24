/**
 * `bro stack` read model — the branch namespace, the recorded edges,
 * the worktree table, and the review host's answers folded into
 * MemberView rows. Everything here READS; the verbs decide. The
 * review/stacks resolvers degrade to `undefined` so a forge-less or
 * offline repo still answers every question the verbs ask.
 */
import { facade, gitTry, reviewHost, stackHost } from '@broject/core';
import type { PrMeta, ReviewFacade, StackFacade } from '@broject/core';
import { nextIndex, stackMembers, stackTop } from '@broject/stack';
import type { SyncMemberInput } from '@broject/stack';
import { loadBroConfig } from '../plugins.ts';
import { dirtyCount, parseWorktreePorcelain, readStackEdges } from './work.ts';
import type { WorktreeInfo } from './work.ts';

export function allBranches(dir: string): string[] {
  return gitTry(['-C', dir, 'branch', '--format=%(refname:short)'])
    .out.split('\n')
    .map(b => b.trim())
    .filter(Boolean);
}

export function localBranch(dir: string, name: string): boolean {
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
 *  the one a default branch tracks. */
function remotesOf(dir: string): string[] {
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
export function ontoBase(dir: string, base: string): string {
  return baseRef(dir, base) ?? base;
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

export interface MemberView extends SyncMemberInput {
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
export function collectMembers(
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

export function resolveReview(root: string): { repo: string; facade: ReviewFacade } | undefined {
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
export function resolveStacks(root: string): StackFacade | undefined {
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
