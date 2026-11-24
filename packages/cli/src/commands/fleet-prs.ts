/** The loop's open-fleet-PR census — the review facade's own listing
 *  when it has one, else a ref scan over every fleet branch (local
 *  worktrees + bare branches + remote heads). `null` answers
 *  'unknown': an incomplete scan is a gate failure, never a partial
 *  pass. Split out of loop.ts — the module was already over the
 *  CodeScene file-size bar and the wave-2 extractions pushed it past
 *  the single-module function count too. */
import { gitTry, type ReviewFacade } from '@broject/core';
import { FLEET_HEAD_PREFIXES, type FleetPrRow, isFleetHead } from '@broject/loop';
import { parseWorktreePorcelain } from './work.ts';

export interface RefTails {
  worktrees: string[];
  /** branch names riding a loop/* worktree — disjoint from `branches`,
   *  needed so the open-PR audit sees PRs on worktree'd branches too */
  worktreeBranches: string[];
  branches: string[];
  errors: string[];
}

/** loop/* worktrees still checked out + loop/* branches with no
 *  worktree — both are run tails; a `--stack` run owns its `stack/<name>/*`
 *  branches the same way. A failed git probe reports as an error line,
 *  never as a false "clean". */
export function loopRefTails(root: string, prefixes: string[] = ['loop/']): RefTails {
  const errors: string[] = [];
  const wt = gitTry(['-C', root, 'worktree', 'list', '--porcelain']);
  if (wt.code !== 0) {
    errors.push(`worktree list failed — ${wt.err || 'git error'}`);
  }
  const trees = parseWorktreePorcelain(wt.out).filter(w =>
    prefixes.some(p => w.branch?.startsWith(p))
  );
  const onTree = new Set(trees.map(w => w.branch!));
  const bare: string[] = [];
  for (const prefix of prefixes) {
    const bl = gitTry(['-C', root, 'branch', '--list', `${prefix}*`, '--format=%(refname:short)']);
    if (bl.code !== 0) {
      errors.push(`branch list failed — ${bl.err || 'git error'}`);
      continue;
    }
    bare.push(...bl.out.split('\n').filter(b => b && !onTree.has(b)));
  }
  return {
    worktrees: trees.map(w => `${w.path} [${w.branch}]`),
    worktreeBranches: trees.map(w => w.branch!),
    branches: bare,
    errors,
  };
}

/** The census input — the three ctx fields the scan reads, typed here
 *  so the module never reaches back into loop.ts's Ctx. */
interface FleetPrsCtx {
  root: string;
  repo: string;
  rev: ReviewFacade;
}

/** The review backend's own open-PR listing — undefined when the facade
 *  names no openPrs (the branch scan answers instead), null when the
 *  listing itself failed (unknown beats incomplete). */
function fleetPrsFromBackend(ctx: FleetPrsCtx): FleetPrRow[] | null | undefined {
  if (typeof ctx.rev.openPrs !== 'function') {
    return undefined;
  }
  try {
    const rows: FleetPrRow[] = [];
    for (const p of ctx.rev.openPrs(ctx.repo) ?? []) {
      if (p?.headRef && isFleetHead(p.headRef)) {
        rows.push({ pr: p.pr, headRef: p.headRef });
      }
    }
    return rows;
  } catch {
    // PR listing failed — cannot produce complete listing
    return null;
  }
}

/** `git ls-remote --heads origin <prefix>*` — the ref names under one
 *  fleet prefix. [] when no origin exists to ask (a local-only fleet
 *  is a complete answer); null when the remote exists but cannot
 *  answer — 'unknown', never an incomplete scan. */
function lsRemoteHeads(root: string, prefix: string): string[] | null {
  const ls = gitTry(['-C', root, 'ls-remote', '--heads', 'origin', `${prefix}*`]);
  if (ls.code === 0) {
    return ls.out
      .split('\n')
      .map(l => l.split('\t')[1]?.replace(/^refs\/heads\//, '') ?? '')
      .filter(Boolean);
  }
  // no origin at all is a complete answer (the fleet is local-only);
  // an unreachable remote is 'unknown'
  if (/does not appear to be a git repository|No such remote|not a git command/i.test(ls.err)) {
    return [];
  }
  return null;
}

/** Remote heads for every fleet prefix — LOCAL refs alone undercount:
 *  a pushed head whose local branch was already deleted (land
 *  cleanup, another clone's push) is still a live fleet PR, so remote
 *  heads join the scan. */
function remoteFleetHeads(root: string, prefixes: readonly string[]): string[] | null {
  const remote: string[] = [];
  for (const prefix of prefixes) {
    const heads = lsRemoteHeads(root, prefix);
    if (heads === null) {
      return null;
    }
    remote.push(...heads);
  }
  return remote;
}

/** One branch's fleet PRs folded into rows — false when the facade
 *  cannot answer the branch at all (a non-fleet branch is still ASKED:
 *  its answer failing makes the listing incomplete too). */
function collectBranchPrs(ctx: FleetPrsCtx, b: string, rows: FleetPrRow[]): boolean {
  try {
    for (const pr of ctx.rev.prsForBranch(b)) {
      if (isFleetHead(b)) {
        rows.push({ pr, headRef: b });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** prsForBranch over the union of known branches — a branch the facade
 *  cannot answer fails the whole listing (unknown beats incomplete). */
function collectBranchFleetPrs(
  ctx: FleetPrsCtx,
  branches: readonly string[],
  rows: FleetPrRow[]
): boolean {
  for (const b of branches) {
    if (!collectBranchPrs(ctx, b, rows)) {
      return false;
    }
  }
  return true;
}

/** The open-fleet-PR census — the review backend's own listing when it
 *  offers one, else a per-branch scan over every local worktree, bare
 *  loop/* branch, and remote fleet head. `null` answers 'unknown': an
 *  incomplete scan is a gate failure, never a partial pass. */
export function listOpenFleetPrs(ctx: FleetPrsCtx): FleetPrRow[] | null {
  const listed = fleetPrsFromBackend(ctx);
  if (listed !== undefined) {
    return listed;
  }
  // fallback: scan known branches - if branch discovery fails or is incomplete, treat as unknown.
  // LOCAL refs alone undercount: a pushed head whose local branch was already
  // deleted (land cleanup, another clone's push) is still a live fleet PR, so
  // remote heads join the scan — `ls-remote` answers the authoritative set.
  const prefixes = FLEET_HEAD_PREFIXES;
  try {
    const tails = loopRefTails(ctx.root, prefixes);
    if (tails.errors.length > 0) {
      return null;
    }
    const remote = remoteFleetHeads(ctx.root, prefixes);
    if (remote === null) {
      return null;
    }
    const branches = [...new Set([...tails.worktreeBranches, ...tails.branches, ...remote])];
    const rows: FleetPrRow[] = [];
    if (!collectBranchFleetPrs(ctx, branches, rows)) {
      return null;
    }
    return rows;
  } catch {
    return null;
  }
}
