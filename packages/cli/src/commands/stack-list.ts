/**
 * `bro stack list` — the chain as the operator sees it: a header per
 * named stack, then one row per member (position, slug, branch,
 * effective base, worktree state, PR state + target), and the publish
 * hint when the host's registry can detect unstacked members.
 * Read-only — nothing here mutates the chain.
 */
import { basename } from 'node:path';
import type { ReviewFacade, StackFacade } from '@broject/core';
import { displayBase, stackNames } from '@broject/stack';
import { positionals } from './args.ts';
import { NAME_FLAGS } from './stack-args.ts';
import type { MemberView } from './stack-refs.ts';
import {
  allBranches,
  collectMembers,
  localBranch,
  resolveReview,
  resolveStacks,
} from './stack-refs.ts';
import { defaultBranchName, mainWorktree, stateOfWorktree } from './work.ts';

/** What every row and the hint read — resolved once per invocation. */
interface ListCtx {
  root: string;
  defaultBase: string;
  rev: { repo: string; facade: ReviewFacade } | undefined;
  stacks: StackFacade | undefined;
}

/** One member row in `stack list` — position, slug, branch, effective
 *  base, worktree state, PR state + target. */
function memberLine(m: MemberView, ctx: ListCtx): string {
  const stale =
    m.edgeBase !== undefined &&
    m.edgeBase !== ctx.defaultBase &&
    !localBranch(ctx.root, m.edgeBase);
  const wt =
    m.worktree === undefined
      ? 'no-worktree'
      : `${basename(m.worktree.path)} ${stateOfWorktree(m.worktree)}`;
  let pr = 'PR?'; // no review host resolved — can't tell
  if (ctx.rev !== undefined) {
    pr =
      m.pr === undefined
        ? 'no-PR'
        : `${ctx.rev.facade.prLink(ctx.rev.repo, m.pr)} ${m.prState}→${m.prBase}`;
  }
  const base = displayBase(m, ctx.defaultBase);
  return `  ${m.n}  ${m.slug}  ${m.branch}  base ${base}${stale ? ' (stale edge)' : ''}  ${wt}  ${pr}`;
}

/** The publish hint — needs both caps: membership detects the gap,
 *  publish is the fix it names. Neither present → the host has no
 *  stack registry and there is nothing to hint at. */
function publishHint(
  name: string,
  members: MemberView[],
  stacks: StackFacade | undefined
): string | undefined {
  const membership = stacks?.membership;
  if (stacks?.publish === undefined || membership === undefined) {
    return undefined;
  }
  const open = members.filter(m => m.pr !== undefined && m.prState === 'OPEN');
  const unstacked = open.filter(m => membership(m) === null);
  if (open.length < 2 || unstacked.length === 0) {
    return undefined;
  }
  return `  ${unstacked.length} of ${open.length} open member PRs not in a stack on the host — \`bro stack publish ${name}\``;
}

/** One stack's report — the header line, its member rows, and the
 *  publish hint when one applies. */
function reportStack(name: string, members: MemberView[], ctx: ListCtx): void {
  console.log(`stack ${name}  (${members.length} member${members.length === 1 ? '' : 's'})`);
  for (const m of members) {
    console.log(memberLine(m, ctx));
  }
  const hint = publishHint(name, members, ctx.stacks);
  if (hint !== undefined) {
    console.log(hint);
  }
}

export function cmdList(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS);
  const main = mainWorktree();
  const ctx: ListCtx = {
    root: main.path,
    defaultBase: defaultBranchName() ?? main.branch ?? 'main',
    rev: resolveReview(main.path),
    stacks: resolveStacks(main.path),
  };
  const names = pos[0] ? [pos[0]] : stackNames(allBranches(ctx.root));
  if (names.length === 0) {
    console.log('no stacks — `bro stack push <bead> --name <stack>` starts one');
    return;
  }
  for (const name of names) {
    reportStack(name, collectMembers(name, ctx.root, ctx.rev), ctx);
  }
}
