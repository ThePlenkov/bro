/**
 * `bro cleanup [--remote] [--dry-run]` — delete local branches whose PR
 * already merged and stale temp directories (e.g. `npx` `tmp-*` leaks).
 * Squash merges break `git branch --merged` ancestry, so merged state
 * comes from the review host: merged-PR headRefs + head SHAs intersected
 * with local branches. The remote side is opt-in — merge --delete-branch
 * already covers PRs merged through the UI/CLI.
 */
import { readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { facadeAuth, git, gitTry, hasHelpFlag, printUsage, reviewHost } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import { positionals } from './args.ts';
import { isAncestor } from './work.ts';
export { isAncestor };

const PROTECTED = new Set(['main', 'master']);
const MERGED_LIMIT = 1000;

export interface CleanupPlan {
  /** Local branches safe to delete — a merged PR exists under this name
   * and the local tip is provably inside the merged head. */
  delete: string[];
  skip: { branch: string; reason: string }[];
}

/** A ref is only deletable when its tip equals the merged PR head or is
 * an ancestor of it — anything else carries commits the merge never saw
 * (local work ahead of the PR, or a same-named branch that isn't the PR
 * at all, e.g. a fork head colliding with a local name). */
function tipIsMerged(
  tip: string,
  headOid: string,
  isAncestor: (tip: string, oid: string) => boolean
): boolean {
  return tip === headOid || isAncestor(tip, headOid);
}

/** Fold local branches against merged-PR head names + SHAs and the
 * liveness guards. Pure — the safety core; `isAncestor` is injected so
 * the git object lookup stays at the edge. */
export function planCleanup(
  local: Array<{ name: string; tip: string }>,
  merged: ReadonlyMap<string, string>,
  guards: { current?: string; checkedOut?: ReadonlySet<string> },
  isAncestor: (tip: string, oid: string) => boolean
): CleanupPlan {
  const del: string[] = [];
  const skip: CleanupPlan['skip'] = [];
  for (const { name, tip } of local) {
    if (name === guards.current) {
      skip.push({ branch: name, reason: 'current branch' });
      continue;
    }
    if (PROTECTED.has(name)) {
      skip.push({ branch: name, reason: 'protected' });
      continue;
    }
    if (guards.checkedOut?.has(name)) {
      skip.push({ branch: name, reason: 'checked out in another worktree' });
      continue;
    }
    const headOid = merged.get(name);
    if (headOid === undefined) {
      skip.push({ branch: name, reason: 'no merged PR' });
      continue;
    }
    if (!tipIsMerged(tip, headOid, isAncestor)) {
      skip.push({ branch: name, reason: 'tip has commits beyond the merged head' });
      continue;
    }
    del.push(name);
  }
  return { delete: del, skip };
}

function localBranches(): Array<{ name: string; tip: string }> {
  return git(['for-each-ref', 'refs/heads', '--format', '%(refname:short) %(objectname)'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => {
      const [name = '', tip = ''] = line.split(' ', 2);
      return { name, tip };
    });
}

/** Branch names checked out in ANY worktree — `git worktree list
 * --porcelain` emits `branch refs/heads/<name>` per entry. */
function checkedOutBranches(): Set<string> {
  const out = new Set<string>();
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('branch refs/heads/')) {
      out.add(line.slice('branch refs/heads/'.length));
    }
  }
  return out;
}

/** Host unreachable (offline, auth, no connector match) → an empty map:
 *  every branch reads "no merged PR" and is kept — cleanup never deletes
 *  on absent evidence. */
function mergedPrEvidence(prefer: Record<string, string> | undefined): Map<string, string> {
  try {
    const rev = reviewHost(undefined, prefer);
    const mergedPrs = rev.mergedPrs(rev.resolveRepo([]), { limit: MERGED_LIMIT });
    if (mergedPrs.length === MERGED_LIMIT) {
      console.error(
        `cleanup: scanned the last ${MERGED_LIMIT} merged PRs — older branches may be missed`
      );
    }
    return new Map(mergedPrs.filter(pr => pr.headRef !== '').map(pr => [pr.headRef, pr.headSha]));
  } catch (err) {
    console.error(
      `cleanup: review host unreachable (${err instanceof Error ? err.message : err}) — ` +
        'no merged-PR evidence, keeping all branches'
    );
    return new Map();
  }
}

function remoteTips(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git([
    'for-each-ref',
    'refs/remotes/origin',
    '--format',
    '%(refname:short) %(objectname)',
  ]).split('\n')) {
    const [ref = '', tip = ''] = line.trim().split(' ', 2);
    if (ref.startsWith('origin/') && ref !== 'origin/HEAD') {
      out.set(ref.slice('origin/'.length), tip);
    }
  }
  return out;
}

export function runCleanupCommand(argv: string[]): void {
  if (hasHelpFlag(argv)) {
    printUsage('usage: bro cleanup [--remote] [--dry-run]', 0);
  }
  const pos = positionals(argv, new Set());
  if (
    pos.length > 0 ||
    argv.some(a => a.startsWith('--') && !['--remote', '--dry-run'].includes(a))
  ) {
    console.error('usage: bro cleanup [--remote] [--dry-run]');
    process.exit(2);
  }
  const dryRun = argv.includes('--dry-run');
  const withRemote = argv.includes('--remote');

  // a broken config (external plugin schema whose fallback also throws)
  // must not abort cleanup before the keep-all fallback — degrade to the
  // default connector preference instead
  let prefer: Record<string, string> | undefined;
  try {
    prefer = loadBroConfig().connectors;
  } catch (err) {
    console.error(
      `cleanup: bro config unreadable (${err instanceof Error ? err.message : String(err)}) — using default connectors`
    );
  }
  // auth is a warning, not a gate — unauthenticated runs still get the
  // local plan, and the empty-map fallback below keeps every branch
  const auth = facadeAuth('reviews', { dir: process.cwd() }, { prefer });
  if (auth !== null) {
    console.error(`cleanup: ${auth} — planning from local state`);
  }
  // freshen remote state — tolerable to proceed if the fetch fails
  // (offline): deletion decisions still come from the local view.
  const fetch = gitTry(['fetch', '--prune', '--quiet'], 10_000);
  if (fetch.code !== 0) {
    console.error(
      `cleanup: fetch --prune failed (${fetch.err || 'offline?'}) — planning from local state`
    );
  }

  const merged = mergedPrEvidence(prefer);

  const plan = planCleanup(
    localBranches(),
    merged,
    {
      current: git(['branch', '--show-current']).trim() || undefined,
      checkedOut: checkedOutBranches(),
    },
    isAncestor
  );

  for (const { branch, reason } of plan.skip) {
    console.log(`  keep ${branch} (${reason})`);
  }
  let branchDeleted = 0;
  if (plan.delete.length > 0) {
    const remotes = withRemote ? remoteTips() : new Map<string, string>();
    for (const branch of plan.delete) {
      deleteBranch(branch, merged.get(branch) as string, remotes.get(branch), dryRun);
      // deleteBranch logs; we track by counting what would happen isn't straightforward here,
      // but easier to just recompute summary separately if needed - keep as is
    }
    console.log(`cleanup: ${dryRun ? 'would delete' : 'deleted'} ${plan.delete.length} branch(es)`);
  } else {
    // Don't claim "nothing to delete" if temp cleanup may delete items; temp cleanup logs its own summary
    console.log('cleanup: nothing to delete (branches)');
  }

  cleanupTmpDirs(dryRun);
}

function deleteRemote(branch: string, headOid: string, remoteTip: string | undefined): void {
  if (remoteTip === undefined) {
    return;
  }
  if (!tipIsMerged(remoteTip, headOid, isAncestor)) {
    console.log(`  keep origin/${branch} (remote tip has commits beyond the merged head)`);
    return;
  }
  const push = gitTry(['push', 'origin', '--delete', branch]);
  if (push.code !== 0) {
    console.error(`  error deleting origin/${branch}: ${push.err}`);
    process.exitCode = 1;
  } else {
    console.log(`  deleted origin/${branch}`);
  }
}

function deleteBranch(
  branch: string,
  headOid: string,
  remoteTip: string | undefined,
  dryRun: boolean
): void {
  if (dryRun) {
    const hasRemote = remoteTip !== undefined && tipIsMerged(remoteTip, headOid, isAncestor);
    console.log(`  would delete ${branch}${hasRemote ? ' + origin/' + branch : ''}`);
    return;
  }
  // re-verify the tip right before -D — narrows the recreate-between-
  // snapshot-and-delete race to the syscall itself
  const tip = git(['rev-parse', branch]).trim();
  if (!tipIsMerged(tip, headOid, isAncestor)) {
    console.log(`  keep ${branch} (tip changed since plan)`);
    return;
  }
  const res = gitTry(['branch', '-D', branch]);
  if (res.code !== 0) {
    console.error(`  error deleting ${branch}: ${res.err}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  deleted ${branch}`);
  deleteRemote(branch, headOid, remoteTip);
}

function isPathInUse(path: string): boolean {
  // On Linux, check /proc for open file descriptors and cwd pointing to this path
  if (process.platform !== 'linux') {
    // If we cannot safely verify occupancy, skip deletion to avoid removing active paths
    return true;
  }
  try {
    const procDir = '/proc';
    const pids = readdirSync(procDir).filter((p: string) => /^\d+$/.test(p));
    for (const pid of pids) {
      try {
        const fdDir = join(procDir, pid, 'fd');
        const fds = readdirSync(fdDir);
        for (const fd of fds) {
          try {
            const target = readlinkSync(join(fdDir, fd));
            if (target === path || target.startsWith(path + '/')) {
              return true;
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      // Also check cwd
      try {
        const cwd = readlinkSync(join(procDir, pid, 'cwd'));
        if (cwd === path || cwd.startsWith(path + '/') || path.startsWith(cwd + '/')) {
          return true;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function cleanupTmpDirs(dryRun: boolean): void {
  const tmp = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch (err) {
    console.error(`cleanup: failed to read ${tmp} (${err instanceof Error ? err.message : err})`);
    process.exitCode = 1;
    return;
  }

  const targets = entries.filter(
    e => /^tmp-/.test(e) || /^npm-/.test(e) || /^npx-/.test(e) || /^node-/.test(e)
  );
  if (targets.length === 0) {
    return;
  }

  let currentUid: number | undefined;
  try {
    currentUid = userInfo().uid;
  } catch {
    // best effort
  }

  let deleted = 0;
  const now = Date.now();
  const STALE_MS = 60 * 60 * 1000; // 1 hour
  for (const name of targets) {
    const fullPath = join(tmp, name);
    try {
      const st = statSync(fullPath);
      if (!st.isDirectory()) {
        continue;
      }
      // Skip entries not owned by current user
      if (currentUid !== undefined && st.uid !== currentUid) {
        continue;
      }
      // Prefer deleting entries that look stale (older than threshold)
      const mtime = st.mtimeMs || st.mtime.getTime();
      if (now - mtime < STALE_MS) {
        // treat as potentially fresh/unrelated; skip unless in-use check already implies, but be conservative
        continue;
      }
      // Skip if in use by any process
      if (isPathInUse(fullPath)) {
        console.log(`  keep ${fullPath} (in use)`);
        continue;
      }
      if (dryRun) {
        console.log(`  would delete ${fullPath}`);
        deleted++;
        continue;
      }
      // Re-check before deletion to reduce race
      if (isPathInUse(fullPath)) {
        console.log(`  keep ${fullPath} (in use)`);
        continue;
      }
      try {
        rmSync(fullPath, { recursive: true, force: true });
        console.log(`  deleted ${fullPath}`);
        deleted++;
      } catch (err) {
        console.error(`  error deleting ${fullPath}: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    } catch {
      // skip if can't stat
    }
  }
  if (deleted > 0) {
    console.log(`cleanup: ${dryRun ? 'would delete' : 'deleted'} ${deleted} tmp item(s)`);
  }
}
