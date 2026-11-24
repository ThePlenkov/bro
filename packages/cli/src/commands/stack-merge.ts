/**
 * `bro stack merge` — land the chain bottom→top through the connector's
 * own mechanism: `gh stack merge` where the extension answers,
 * bottom-up `PUT …/merge` on GitLab (the platform retargets between
 * layers), the same per-layer drive on a bare GitHub remote, plain
 * `git merge` forge-less. Every OPEN member's review gate is evaluated
 * BEFORE the first merge call — refusing early keeps even the
 * per-layer fallback effectively all-or-nothing on the gate axis.
 */
import {
  acquireMergeSlot,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  releaseMergeSlot,
  resolveLedger,
} from '@broject/act';
import type {
  ReviewFacade,
  StackChainMember,
  StackFacade,
  StackMergeOpts,
  StackMergeReport,
} from '@broject/core';
import { MANUAL_CASCADE, mergeChainPerLayer } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import { positionals } from './args.ts';
import {
  MERGE_BOOL_FLAGS,
  NAME_FLAGS,
  printLines,
  requiredStackName,
  usage,
} from './stack-args.ts';
import type { MemberView } from './stack-refs.ts';
import { collectMembers, resolveReview, resolveStacks } from './stack-refs.ts';
import { retireMerged, syncStack } from './stack-sync.ts';
import { defaultBranchName, mainWorktree, type WorktreeInfo } from './work.ts';

/** Per-merge context — resolved once, read by every step. */
interface MergeCtx {
  /** The main worktree's path — config, ledger, and worktree table root. */
  root: string;
  /** The repo's default branch — the merge chain's declared base. */
  trunk: string;
  rev: { repo: string; facade: ReviewFacade } | undefined;
  stacks: StackFacade | undefined;
  /** The act config the exit gates evaluate with. */
  act: ReturnType<typeof loadBroConfig>['act'];
}

/** The merge verb's opts — the strategy flags are exclusive, `squash`
 *  is the default the platform offers. */
function parseMergeOpts(argv: string[]): StackMergeOpts {
  const picked = (['--squash', '--merge', '--rebase'] as const).filter(f => argv.includes(f));
  if (picked.length > 1) {
    console.error(`error: ${picked.join(' ')} — merge strategy flags are exclusive`);
    usage();
  }
  return {
    method: (picked[0]?.slice(2) ?? 'squash') as StackMergeOpts['method'],
    admin: argv.includes('--admin'),
  };
}

/** Everything the merge steps read, resolved once. */
function mergeContext(main: WorktreeInfo): MergeCtx {
  return {
    root: main.path,
    trunk: defaultBranchName() ?? main.branch ?? 'main',
    rev: resolveReview(main.path),
    stacks: resolveStacks(main.path),
    act: loadBroConfig(main.path).act,
  };
}

/** The contiguous prefix that CAN land — on a review host that means
 *  an OPEN PR per member, so a PR-less or closed member breaks the
 *  chain (nothing merges past it). Forge-less, every member is
 *  mergeable: git lands the whole chain. `undefined` is a refusal —
 *  the reason was already printed. */
function mergeablePrefix(live: MemberView[], ctx: MergeCtx): MemberView[] | undefined {
  if (ctx.rev === undefined) {
    if (ctx.stacks?.mergeChain === undefined) {
      console.error(
        'error: no merge path — no review host and no stacks connector serve this repo'
      );
      return undefined;
    }
    return live;
  }
  const cut = live.findIndex(m => m.pr === undefined || m.prState !== 'OPEN');
  const mergeable = cut === -1 ? live : live.slice(0, cut);
  if (mergeable.length === 0) {
    console.error(
      `error: bottom member ${live[0]!.branch} has no OPEN PR — nothing can merge past it`
    );
    return undefined;
  }
  if (mergeable.length < live.length) {
    console.log(`  ${live[mergeable.length]!.branch} has no OPEN PR — merge stops below it`);
  }
  return mergeable;
}

/** One member's exit-gate verdict — the PR and its blockers when it
 *  refuses, undefined when it passes (or carries no PR to gate). */
async function gateBlockers(
  rev: { repo: string; facade: ReviewFacade },
  m: MemberView,
  ctx: MergeCtx
): Promise<{ pr: number; blockers: string[] } | undefined> {
  if (m.pr === undefined) {
    return undefined; // unreachable — the prefix guarantees an OPEN PR
  }
  const state = await fetchPrActState(
    rev.facade,
    { repo: rev.repo, pr: m.pr },
    {
      ignoreChecks: ctx.act.ignoreChecks,
      checkHistory: checkHistory(ctx.root),
      maxRounds: ctx.act.maxRounds,
      docsPaths: ctx.act.docsPaths,
      docsMaxRounds: ctx.act.docsMaxRounds,
      requireApproval: ctx.act.requireApproval,
      approvers: ctx.act.approvers,
      resolveLedger: resolveLedger(ctx.root),
    }
  );
  const gate = evaluateExitGate(state, { requireApproval: ctx.act.requireApproval });
  return gate.ok ? undefined : { pr: m.pr, blockers: gate.blockers };
}

/** The blocked report — the PR link, the branch, and every blocker. */
function reportGateBlock(
  rev: { repo: string; facade: ReviewFacade },
  m: MemberView,
  refused: { pr: number; blockers: string[] }
): void {
  console.error(
    `exit_gate=BLOCKED — refusing to merge; ${rev.facade.prLink(rev.repo, refused.pr)} (${m.branch}) is not ready:`
  );
  for (const b of refused.blockers) {
    console.error(`  blocker: ${b}`);
  }
}

/** Gate every mergeable layer before the first merge — an unresolved
 *  thread three layers up must not leave the bottom two landed. */
async function gateMergeable(
  mergeable: MemberView[],
  rev: { repo: string; facade: ReviewFacade },
  ctx: MergeCtx
): Promise<boolean> {
  for (const m of mergeable) {
    const refused = await gateBlockers(rev, m, ctx);
    if (refused !== undefined) {
      reportGateBlock(rev, m, refused);
      return false;
    }
  }
  return true;
}

/** The connector's merge — the host's stack tool first, the per-layer
 *  review fallback next. `undefined` when neither serves this repo:
 *  a stacks facade that declined and no review host to fall back on —
 *  git-only connectors always carry mergeChain, so this is the
 *  no-connector corner. */
function mergeChain(
  chain: StackChainMember[],
  opts: StackMergeOpts,
  ctx: MergeCtx
): StackMergeReport | undefined {
  return (
    ctx.stacks?.mergeChain?.(chain, opts) ??
    (ctx.rev !== undefined
      ? mergeChainPerLayer(
          ctx.rev.facade,
          ctx.rev.repo,
          chain,
          opts,
          m => ctx.stacks?.cascade?.(m) ?? MANUAL_CASCADE
        )
      : undefined)
  );
}

/** A PR-less member that landed is invisible to sync's MERGED
 *  detection — retire it here; members with reviews retire inside
 *  the sync pass their host reports. */
function retireLanded(mergeable: MemberView[], merged: string[], root: string): string[] {
  const landed = new Set(merged);
  const lines: string[] = [];
  for (const m of mergeable) {
    if (landed.has(m.branch) && m.pr === undefined) {
      retireMerged(m, root, lines);
    }
  }
  return lines;
}

/** The held-slot refusal — another session is merging, the caller
 *  reports the holder and exits nonzero. */
function reportSlotHeld(holder: string): void {
  console.error(
    `merge slot held by ${holder} — another session is merging; ` +
      'wait for `bd merge-slot check` to report available'
  );
}

/** The gated critical section — the exit gates, the connector's
 *  merge, the PR-less retirement, and the post-merge cascade (the
 *  same pass `bro stack sync` runs). False when a gate refused or no
 *  connector could land the chain. */
async function landMergeChain(
  name: string,
  mergeable: MemberView[],
  opts: StackMergeOpts,
  ctx: MergeCtx
): Promise<boolean> {
  if (ctx.rev !== undefined && !(await gateMergeable(mergeable, ctx.rev, ctx))) {
    return false;
  }
  const chain: StackChainMember[] = mergeable.map(m => ({
    branch: m.branch,
    base: ctx.trunk,
    pr: m.pr,
    headSha: m.headSha,
  }));
  const report = mergeChain(chain, opts, ctx);
  if (report === undefined) {
    console.error('error: stack merge declined — no connector can merge this chain');
    return false;
  }
  printLines(report.lines);
  printLines(retireLanded(mergeable, report.merged, ctx.root));
  printLines(syncStack(ctx.root, name));
  return true;
}

export async function cmdMerge(argv: string[]): Promise<void> {
  const pos = positionals(argv, NAME_FLAGS, { boolFlags: MERGE_BOOL_FLAGS, strict: true });
  const name = requiredStackName(argv, pos);
  const opts = parseMergeOpts(argv);
  const main = mainWorktree();
  const ctx = mergeContext(main);
  const members = collectMembers(name, ctx.root, ctx.rev);
  if (members.length === 0) {
    console.log(`stack ${name} has no members — nothing to merge`);
    return;
  }
  const live = members.filter(m => m.prState !== 'MERGED');
  if (live.length === 0) {
    console.log('nothing to merge — every member already landed');
    return;
  }
  const mergeable = mergeablePrefix(live, ctx);
  if (mergeable === undefined) {
    process.exitCode = 1;
    return;
  }
  // gate evaluation → merge is one critical section, same as act merge —
  // the slot wraps the checks themselves: taken after them, another merge
  // could move a PR between its gate read and its landing
  const slot = acquireMergeSlot();
  if (slot.kind === 'held') {
    reportSlotHeld(slot.holder);
    process.exitCode = 1;
    return;
  }
  try {
    if (!(await landMergeChain(name, mergeable, opts, ctx))) {
      process.exitCode = 1;
    }
  } finally {
    if (slot.kind === 'acquired') {
      releaseMergeSlot();
    }
  }
}
