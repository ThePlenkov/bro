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
import { hasHelpFlag } from '@broject/core';
import { usage } from './stack-args.ts';
import { cmdList } from './stack-list.ts';
import { cmdMerge } from './stack-merge.ts';
import { cmdPush } from './stack-push.ts';
import { cmdPublish } from './stack-register.ts';
import { cmdSync } from './stack-sync.ts';

export { chainRootBase, forkFor, forkPoint } from './stack-fork.ts';
export type { MemberView } from './stack-refs.ts';
export {
  baseRef,
  mergedBranches,
  stackMemberFor,
  stackTip,
} from './stack-refs.ts';
export { syncStack } from './stack-sync.ts';

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
