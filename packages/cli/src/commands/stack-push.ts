/**
 * `bro stack push` — mint the next `stack/<name>/<n>-<slug>` member:
 * a sibling worktree on a branch based on the stack tip (the first
 * member bases on the default branch). Re-pushing a bead that already
 * sits in the stack re-enters its member — push is idempotent, never
 * a duplicate position. The push lock serializes member-listing →
 * worktree-add across bro processes.
 */
import { acquireFileLock, LockTimeout, type StackFacade, shQuote } from '@broject/core';
import { formatStackBranch, isStackName } from '@broject/stack';
import { positionals } from './args.ts';
import { NAME_FLAGS, resolveStackName, usage } from './stack-args.ts';
import {
  mergedBranches,
  resolveReview,
  resolveStacks,
  stackMemberFor,
  stackTip,
} from './stack-refs.ts';
import {
  createWorktree,
  defaultBranchName,
  type EnterWorktreeResult,
  finishWorktreeEnter,
  mainWorktree,
  readStackEdges,
  stackPushLockPath,
  type WorktreeCreateResult,
} from './work.ts';

export function cmdPush(argv: string[]): void {
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
