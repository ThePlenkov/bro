/**
 * `bro cleanup [--remote] [--dry-run]` — delete local branches whose PR
 * already merged. Squash merges break `git branch --merged` ancestry, so
 * merged state comes from GitHub: `gh pr list --state merged` headRefNames
 * + head SHAs intersected with local branches. The remote side is opt-in
 * — `gh pr merge --delete-branch` already covers PRs merged through the
 * UI/CLI.
 */
import { ensureGhAuth, ghJson, git, gitTry } from '@bro/core'
import { positionals } from './args.ts'

const PROTECTED = new Set(['main', 'master'])
const MERGED_LIMIT = 1000

export interface CleanupPlan {
  /** Local branches safe to delete — a merged PR exists under this name
   * and the local tip is provably inside the merged head. */
  delete: string[]
  skip: { branch: string; reason: string }[]
}

/** A ref is only deletable when its tip equals the merged PR head or is
 * an ancestor of it — anything else carries commits the merge never saw
 * (local work ahead of the PR, or a same-named branch that isn't the PR
 * at all, e.g. a fork head colliding with a local name). */
function tipIsMerged(
  tip: string,
  headOid: string,
  isAncestor: (tip: string, oid: string) => boolean,
): boolean {
  return tip === headOid || isAncestor(tip, headOid)
}

/** Fold local branches against merged-PR head names + SHAs and the
 * liveness guards. Pure — the safety core; `isAncestor` is injected so
 * the git object lookup stays at the edge. */
export function planCleanup(
  local: Array<{ name: string; tip: string }>,
  merged: ReadonlyMap<string, string>,
  guards: { current?: string; checkedOut?: ReadonlySet<string> },
  isAncestor: (tip: string, oid: string) => boolean,
): CleanupPlan {
  const del: string[] = []
  const skip: CleanupPlan['skip'] = []
  for (const { name, tip } of local) {
    if (name === guards.current) {
      skip.push({ branch: name, reason: 'current branch' })
      continue
    }
    if (PROTECTED.has(name)) {
      skip.push({ branch: name, reason: 'protected' })
      continue
    }
    if (guards.checkedOut?.has(name)) {
      skip.push({ branch: name, reason: 'checked out in another worktree' })
      continue
    }
    const headOid = merged.get(name)
    if (headOid === undefined) {
      skip.push({ branch: name, reason: 'no merged PR' })
      continue
    }
    if (!tipIsMerged(tip, headOid, isAncestor)) {
      skip.push({ branch: name, reason: 'tip has commits beyond the merged head' })
      continue
    }
    del.push(name)
  }
  return { delete: del, skip }
}

function localBranches(): Array<{ name: string; tip: string }> {
  return git(['for-each-ref', 'refs/heads', '--format', '%(refname:short) %(objectname)'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', tip = ''] = line.split(' ', 2)
      return { name, tip }
    })
}

/** Branch names checked out in ANY worktree — `git worktree list
 * --porcelain` emits `branch refs/heads/<name>` per entry. */
function checkedOutBranches(): Set<string> {
  const out = new Set<string>()
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('branch refs/heads/')) {
      out.add(line.slice('branch refs/heads/'.length))
    }
  }
  return out
}

function remoteTips(): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of git([
    'for-each-ref',
    'refs/remotes/origin',
    '--format',
    '%(refname:short) %(objectname)',
  ]).split('\n')) {
    const [ref = '', tip = ''] = line.trim().split(' ', 2)
    if (ref.startsWith('origin/') && ref !== 'origin/HEAD') {
      out.set(ref.slice('origin/'.length), tip)
    }
  }
  return out
}

/** `tip` reachable from `oid` — only meaningful when the oid object is
 * present locally (merged heads on deleted remote branches may not be). */
export function isAncestor(tip: string, oid: string): boolean {
  if (gitTry(['cat-file', '-e', oid]).code !== 0) {
    return false
  }
  return gitTry(['merge-base', '--is-ancestor', tip, oid]).code === 0
}

export function runCleanupCommand(argv: string[]): void {
  const pos = positionals(argv, new Set())
  if (pos.length > 0 || argv.some((a) => a.startsWith('--') && !['--remote', '--dry-run'].includes(a))) {
    console.error('usage: bro cleanup [--remote] [--dry-run]')
    process.exit(2)
  }
  const dryRun = argv.includes('--dry-run')
  const withRemote = argv.includes('--remote')

  ensureGhAuth()
  // freshen remote state — tolerable to proceed if the fetch fails
  // (offline): deletion decisions still come from the local view.
  const fetch = gitTry(['fetch', '--prune', '--quiet'])
  if (fetch.code !== 0) {
    console.error(`cleanup: fetch --prune failed (${fetch.err || 'offline?'}) — planning from local state`)
  }

  const mergedPrs = ghJson<Array<{ headRefName: string; headRefOid: string }>>([
    'pr',
    'list',
    '--state',
    'merged',
    '--limit',
    String(MERGED_LIMIT),
    '--json',
    'headRefName,headRefOid',
  ])
  const merged = new Map(mergedPrs.map((pr) => [pr.headRefName, pr.headRefOid]))
  if (mergedPrs.length === MERGED_LIMIT) {
    console.error(`cleanup: scanned the last ${MERGED_LIMIT} merged PRs — older branches may be missed`)
  }

  const plan = planCleanup(localBranches(), merged, {
    current: git(['branch', '--show-current']).trim() || undefined,
    checkedOut: checkedOutBranches(),
  }, isAncestor)

  for (const { branch, reason } of plan.skip) {
    console.log(`  keep ${branch} (${reason})`)
  }
  if (plan.delete.length === 0) {
    console.log('cleanup: nothing to delete')
    return
  }

  const remotes = withRemote ? remoteTips() : new Map<string, string>()
  for (const branch of plan.delete) {
    deleteBranch(branch, merged.get(branch) as string, remotes.get(branch), dryRun)
  }
  console.log(`cleanup: ${dryRun ? 'would delete' : 'deleted'} ${plan.delete.length} branch(es)`)
}

function deleteRemote(branch: string, headOid: string, remoteTip: string | undefined): void {
  if (remoteTip === undefined) {
    return
  }
  if (!tipIsMerged(remoteTip, headOid, isAncestor)) {
    console.log(`  keep origin/${branch} (remote tip has commits beyond the merged head)`)
    return
  }
  const push = gitTry(['push', 'origin', '--delete', branch])
  if (push.code !== 0) {
    console.error(`  error deleting origin/${branch}: ${push.err}`)
    process.exitCode = 1
  } else {
    console.log(`  deleted origin/${branch}`)
  }
}

function deleteBranch(
  branch: string,
  headOid: string,
  remoteTip: string | undefined,
  dryRun: boolean,
): void {
  if (dryRun) {
    const hasRemote = remoteTip !== undefined && tipIsMerged(remoteTip, headOid, isAncestor)
    console.log(`  would delete ${branch}${hasRemote ? ' + origin/' + branch : ''}`)
    return
  }
  // re-verify the tip right before -D — narrows the recreate-between-
  // snapshot-and-delete race to the syscall itself
  const tip = git(['rev-parse', branch]).trim()
  if (!tipIsMerged(tip, headOid, isAncestor)) {
    console.log(`  keep ${branch} (tip changed since plan)`)
    return
  }
  const res = gitTry(['branch', '-D', branch])
  if (res.code !== 0) {
    console.error(`  error deleting ${branch}: ${res.err}`)
    process.exitCode = 1
    return
  }
  console.log(`  deleted ${branch}`)
  deleteRemote(branch, headOid, remoteTip)
}
