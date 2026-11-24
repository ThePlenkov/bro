/**
 * `bro stack publish` — register the chain's open member PRs as the
 * host's server-side stack (`gh stack link` on GitHub). Hosts that
 * detect chains from the base links themselves (GitLab, plain git)
 * decline the call, and the verb says so rather than pretending.
 * `stack sync` reuses the same registration as its post-cascade tail.
 */
import type { StackChainMember, StackFacade } from '@broject/core';
import { displayBase } from '@broject/stack';
import { positionals } from './args.ts';
import { NAME_FLAGS, printLines, requiredStackName } from './stack-args.ts';
import type { MemberView } from './stack-refs.ts';
import { collectMembers, resolveReview, resolveStacks } from './stack-refs.ts';
import { defaultBranchName, mainWorktree } from './work.ts';

/** What publish settled into — 'skipped' is the benign quiet path
 *  (fewer than two open PRs, nothing attempted): the sync caller must
 *  not read it as a failure. Only 'failed' propagates — a split
 *  refusal, a thrown link, or an unproven membership readback. */
export type PublishOutcome = 'registered' | 'skipped' | 'failed';

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

/** The benign quiet path — fewer than two open member PRs means the
 *  chain has nothing to register yet: 'skipped', never a failure. */
function skipQuiet(name: string, lines: string[], quiet: boolean): PublishOutcome {
  if (!quiet) {
    lines.push(`  stack ${name}: fewer than two open member PRs — nothing to publish`);
  }
  return 'skipped';
}

/** Register the chain's open member PRs as the host's stack object —
 *  `gh stack link` on GitHub, absent everywhere chains are detected
 *  from the base links themselves. `quiet` is the cascade caller:
 *  benign no-ops (<2 open PRs, already registered) print nothing — a
 *  refusal still does, it's real signal about the chain. 'registered'
 *  means the members ended up in a stack — the post-publish membership
 *  readback is the success proof, so an empty one fails, not passes. */
export function publishStack(
  name: string,
  members: MemberView[],
  stacks: StackFacade,
  defaultBase: string,
  lines: string[],
  quiet: boolean
): PublishOutcome {
  const open = members.filter(m => m.pr !== undefined && m.prState === 'OPEN');
  if (open.length < 2) {
    return skipQuiet(name, lines, quiet);
  }
  const pre =
    stacks.membership === undefined
      ? 'unproven'
      : membershipPreflight(name, open, stacks.membership, lines, quiet);
  if (pre === 'refused') {
    return 'failed';
  }
  if (pre === 'registered') {
    return 'registered';
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
export function cmdPublish(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS);
  const name = requiredStackName(argv, pos);
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
  printLines(lines);
}
