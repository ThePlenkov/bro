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
  hasHelpFlag,
  LockTimeout,
  MANUAL_CASCADE,
  mergeChainPerLayer,
  type ReviewFacade,
  type StackChainMember,
  type StackFacade,
  type StackMergeOpts,
  shQuote,
} from '@broject/core';
import { displayBase, formatStackBranch, isStackName, stackNames } from '@broject/stack';
import { loadBroConfig } from '../plugins.ts';
import { positionals } from './args.ts';
import {
  MERGE_BOOL_FLAGS,
  NAME_FLAGS,
  requiredStackName,
  resolveStackName,
  usage,
} from './stack-args.ts';
import type { MemberView } from './stack-refs.ts';
import {
  allBranches,
  collectMembers,
  localBranch,
  mergedBranches,
  resolveReview,
  resolveStacks,
  stackMemberFor,
  stackTip,
} from './stack-refs.ts';
import { cmdPublish } from './stack-register.ts';
import { cmdSync, retireMerged, syncStack } from './stack-sync.ts';
import {
  createWorktree,
  defaultBranchName,
  type EnterWorktreeResult,
  finishWorktreeEnter,
  mainWorktree,
  readStackEdges,
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
export { syncStack } from './stack-sync.ts';

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
