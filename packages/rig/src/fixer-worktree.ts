/**
 * Fixer worktree materialization — the checkout a drive fixer lands on:
 * reuse a standing tree on the PR branch or add a fresh
 * `<repo>--<slug>` one, always at a tip that can reach
 * `origin/<branch>`. Moved from `commands/drive.ts` in the
 * fleet-lifecycle extraction (bro-jamp7): the materialize/retire
 * decisions are engine; the spawn ceremony that consumes them stays in
 * the command layer.
 */
import { existsSync } from 'node:fs';
import { emitLifecycle, gitTry, worktreePathFor } from '@broject/core';
import { branchSlug } from './occupancy.ts';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** <local> vs origin/<branch> is linear — one contains the other, so a
 *  checkout of it can always reach the remote tip (ahead/equal already
 *  does, behind fast-forwards). Divergence is refused to every fixer
 *  path: a rebase replaying a tip that misses remote commits drops them
 *  when the lease push lands (the lease itself passes — the tracking
 *  ref was just refreshed by the fetch). Missing refs — no remote, an
 *  unborn branch — pass: nothing to check against. */
function remoteLinear(root: string, local: string, branch: string): boolean {
  const remote = `origin/${branch}`;
  if (
    gitTry(['-C', root, 'rev-parse', '--verify', remote]).code !== 0 ||
    gitTry(['-C', root, 'rev-parse', '--verify', local]).code !== 0
  ) {
    return true;
  }
  return (
    gitTry(['-C', root, 'merge-base', '--is-ancestor', remote, local]).code === 0 ||
    gitTry(['-C', root, 'merge-base', '--is-ancestor', local, remote]).code === 0
  );
}

/** A standing checkout's refresh to origin/<branch>'s tip — the same ff
 *  the create path runs. Divergence is excluded by remoteLinear before
 *  the loop, so a ff refusal is a dirty or mid-merge tree — reported,
 *  never clobbered. No remote ref passes: nothing to be stale against. */
function ffToRemoteTip(dir: string, branch: string): boolean {
  const remote = `origin/${branch}`;
  if (gitTry(['-C', dir, 'rev-parse', '--verify', remote]).code !== 0) {
    return true;
  }
  return gitTry(['-C', dir, 'merge', '--ff-only', remote, '--quiet']).code === 0;
}

/** A standing checkout of <branch> at <dir> — handed over once it can
 *  reach the remote tip: a standing checkout can still lag commits
 *  pushed since it was made, so it fast-forwards like the create path.
 *  undefined when the dir stands on another branch (foreign — never
 *  clobbered). */
function reuseFixerWorktree(
  dir: string,
  branch: string
): { path?: string; err?: string } | undefined {
  const on = gitTry(['-C', dir, 'branch', '--show-current']).out.trim();
  if (on !== branch) {
    return undefined;
  }
  if (!ffToRemoteTip(dir, branch)) {
    return { err: `${dir} can't fast-forward to origin/${branch}` };
  }
  return { path: dir };
}

/** The fresh `<repo>--<slug>` checkout: the existing local branch, else
 *  a new one at origin/<branch>'s tip — the orphan-PR shape. */
function addFixerWorktree(
  mainRoot: string,
  dir: string,
  branch: string
): { path?: string; created?: boolean; err?: string } {
  const add = gitTry(['-C', mainRoot, 'worktree', 'add', dir, branch]);
  if (add.code === 0) {
    // the fetch refreshed origin/<branch>, not the local ref the
    // worktree just checked out — ff or the fixer works a stale tip;
    // a refusal means the branch moved mid-call — retire the dir we
    // just made rather than hand over a tip that can't cover it
    if (!ffToRemoteTip(dir, branch)) {
      gitTry(['-C', mainRoot, 'worktree', 'remove', dir]);
      return { err: `${branch} moved while its worktree was being added` };
    }
    emitLifecycle(mainRoot, {
      kind: 'worktree',
      to: 'created',
      detail: { via: 'drive', worktree: dir, branch },
    });
    return { path: dir, created: true };
  }
  const retry = gitTry(['-C', mainRoot, 'worktree', 'add', '-b', branch, dir, `origin/${branch}`]);
  if (retry.code === 0) {
    emitLifecycle(mainRoot, {
      kind: 'worktree',
      to: 'created',
      detail: { via: 'drive', worktree: dir, branch },
    });
    return { path: dir, created: true };
  }
  return { err: retry.err || add.err };
}

/** The PR's fixer checkout: the branch's existing worktree, else a fresh
 *  `<repo>--<slug>` on it — `created` marks a dir this call added so the
 *  caller can retire it when the work evaporates. A dir standing on
 *  another branch is never clobbered: distinct branches sharing the
 *  final slug (work/x vs loop/x) fall back to the branch-namespaced
 *  `<repo>--work-x` path instead of refusing as foreign. Either path is
 *  handed over only once it can reach origin/<branch>'s tip — a fixer
 *  rebasing a stale tip omits the commits pushed since, and the lease
 *  push drops them on the PR.
 *
 *  `guard` is the occupancy answer for a candidate checkout (bro-by8d3):
 *  a checkout a live session owns is never refreshed — the branch of
 *  another writer is not moved, not even by a fast-forward. The guard
 *  closes the window BEFORE the mutation; the spawn's locked re-check
 *  closes it before the spawn. */
export function ensureFixerWorktree(
  mainRoot: string,
  branch: string,
  opts?: {
    /** The occupancy answer for a candidate checkout — asked UNDER the
     *  occupancy locks, right before the refresh (bro-by8d3). */
    guard?: (dir: string) => string | undefined;
    /** The occupancy locks — held across the guard AND the refresh, so
     *  a claim cannot land between them (a claimant writes its registry
     *  entry + .work marker under the same locks). */
    lock?: (dir: string) => () => void;
  }
): { path?: string; created?: boolean; err?: string; occupied?: string } {
  // fetch first — an orphaned PR's remote head may be newer than ours;
  // a branch diverged from it is refused outright: no checkout of it
  // can keep both histories
  gitTry(['-C', mainRoot, 'fetch', 'origin', branch, '--quiet']);
  if (!remoteLinear(mainRoot, branch, branch)) {
    return { err: `${branch} diverged from origin/${branch}` };
  }
  for (const name of new Set([branchSlug(branch), branch.replaceAll('/', '-')])) {
    const dir = worktreePathFor(mainRoot, name);
    if (existsSync(dir)) {
      // a dir standing on ANOTHER branch is not this branch's checkout:
      // it is never clobbered, and it must not consume the occupancy
      // guard either — the namespaced fallback still has to be tried
      const on = gitTry(['-C', dir, 'branch', '--show-current']).out.trim();
      if (on !== branch) {
        continue;
      }
      // the guard and the refresh share the occupancy locks: a session
      // that claims this checkout after the guard would have its branch
      // moved under it
      let release: () => void = () => {};
      try {
        release = opts?.lock?.(dir) ?? (() => {});
      } catch (err) {
        // a lock we can't take is indistinguishable from an active claimer
        return { occupied: `occupancy re-check failed — ${errText(err)}` };
      }
      try {
        const owner = opts?.guard?.(dir);
        if (owner !== undefined) {
          return { occupied: owner };
        }
        const r = reuseFixerWorktree(dir, branch);
        if (r !== undefined) {
          return r;
        }
      } finally {
        release();
      }
      continue;
    }
    return addFixerWorktree(mainRoot, dir, branch);
  }
  return {
    err: `every worktree path for ${branch} is held by a foreign branch`,
  };
}
