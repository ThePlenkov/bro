/**
 * `bro cleanup [--remote] [--dry-run]` — delete local branches whose PR
 * already merged. Squash merges break `git branch --merged` ancestry, so
 * merged state comes from GitHub: `gh pr list --state merged` headRefNames
 * intersected with local branches. The remote side is opt-in — `gh pr
 * merge --delete-branch` already covers PRs merged through the UI/CLI.
 */
import { ensureGhAuth, ghJson, git, gitTry } from '@bro/core'
import { positionals } from './args.ts'

const PROTECTED = new Set(['main', 'master'])

export interface CleanupPlan {
  /** Local branches safe to delete — a merged PR exists under this name. */
  delete: string[]
  skip: { branch: string; reason: string }[]
}

/** Fold local branches against merged-PR head names + liveness guards.
 * Pure — the safety core: only an upstream-verified merged head is
 * deletable, never the current branch, a protected name, or a branch
 * checked out in another worktree. */
export function planCleanup(
  local: string[],
  merged: ReadonlySet<string>,
  guards: { current?: string; checkedOut?: ReadonlySet<string> },
): CleanupPlan {
  const del: string[] = []
  const skip: CleanupPlan['skip'] = []
  for (const branch of local) {
    if (branch === guards.current) {
      skip.push({ branch, reason: 'current branch' })
      continue
    }
    if (PROTECTED.has(branch)) {
      skip.push({ branch, reason: 'protected' })
      continue
    }
    if (guards.checkedOut?.has(branch)) {
      skip.push({ branch, reason: 'checked out in another worktree' })
      continue
    }
    if (!merged.has(branch)) {
      skip.push({ branch, reason: 'no merged PR' })
      continue
    }
    del.push(branch)
  }
  return { delete: del, skip }
}

function localBranches(): string[] {
  return git(['for-each-ref', 'refs/heads', '--format', '%(refname:short)'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
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

function remoteBranches(): Set<string> {
  const out = new Set<string>()
  for (const line of git(['for-each-ref', 'refs/remotes/origin', '--format', '%(refname:short)']).split('\n')) {
    const name = line.trim()
    if (name.startsWith('origin/')) {
      out.add(name.slice('origin/'.length))
    }
  }
  return out
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

  const merged = new Set(
    ghJson<Array<{ headRefName: string }>>([
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      '500',
      '--json',
      'headRefName',
    ]).map((pr) => pr.headRefName),
  )
  const plan = planCleanup(localBranches(), merged, {
    current: git(['branch', '--show-current']).trim() || undefined,
    checkedOut: checkedOutBranches(),
  })

  for (const { branch, reason } of plan.skip) {
    console.log(`  keep ${branch} (${reason})`)
  }
  if (plan.delete.length === 0) {
    console.log('cleanup: nothing to delete')
    return
  }

  const remotes = withRemote ? remoteBranches() : new Set<string>()
  for (const branch of plan.delete) {
    if (dryRun) {
      console.log(`  would delete ${branch}${remotes.has(branch) ? ' + origin/' + branch : ''}`)
      continue
    }
    const res = gitTry(['branch', '-D', branch])
    if (res.code !== 0) {
      console.error(`  error deleting ${branch}: ${res.err}`)
      process.exitCode = 1
      continue
    }
    console.log(`  deleted ${branch}`)
    if (remotes.has(branch)) {
      const push = gitTry(['push', 'origin', '--delete', branch])
      if (push.code !== 0) {
        console.error(`  error deleting origin/${branch}: ${push.err}`)
        process.exitCode = 1
      } else {
        console.log(`  deleted origin/${branch}`)
      }
    }
  }
  console.log(`cleanup: ${dryRun ? 'would delete' : 'deleted'} ${plan.delete.length} branch(es)`)
}
