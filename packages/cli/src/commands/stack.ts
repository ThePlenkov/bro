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
import type { ReviewFacade } from '@broject/core';
import { hasHelpFlag } from '@broject/core';
import { displayBase, stackNames } from '@broject/stack';
import { positionals } from './args.ts';
import { NAME_FLAGS, usage } from './stack-args.ts';
import { cmdMerge } from './stack-merge.ts';
import { cmdPush } from './stack-push.ts';
import type { MemberView } from './stack-refs.ts';
import {
  allBranches,
  collectMembers,
  localBranch,
  resolveReview,
  resolveStacks,
} from './stack-refs.ts';
import { cmdPublish } from './stack-register.ts';
import { cmdSync } from './stack-sync.ts';
import { defaultBranchName, mainWorktree, stateOfWorktree } from './work.ts';

export { chainRootBase, forkFor, forkPoint } from './stack-fork.ts';
export type { MemberView } from './stack-refs.ts';
export {
  baseRef,
  mergedBranches,
  stackMemberFor,
  stackTip,
} from './stack-refs.ts';
export { syncStack } from './stack-sync.ts';

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
