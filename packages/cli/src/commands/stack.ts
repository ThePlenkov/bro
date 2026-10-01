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
 *                       (first member bases on the main checkout's branch)
 *   bro stack list [<name>]   the chain: position, bead, branch, base,
 *                             worktree state, PR
 *   bro stack sync [<name>]   after a member merges: retarget open child
 *                             PRs and rebase child branches onto the new
 *                             base; dirty or locked worktrees are skipped
 *                             and reported — the owner rebases on enter
 */
import { basename } from 'node:path'
import { gitTry, reviewHost, type PrMeta, type ReviewFacade } from '@broject/core'
import {
  displayBase,
  formatStackBranch,
  isStackName,
  nextIndex,
  parseStackBranch,
  planSync,
  stackMembers,
  stackNames,
  type SyncMemberInput,
} from '@broject/stack'
import { flag, positionals } from './args.ts'
import { loadBroConfig } from '../plugins.ts'
import {
  dirtyCount,
  enterWorktree,
  mainWorktree,
  defaultBranchName,
  parseWorktreePorcelain,
  readStackEdges,
  recordStackEdge,
  removeStackEdge,
  stateOfWorktree,
  type WorktreeInfo,
} from './work.ts'

const NAME_FLAGS = new Set(['--name'])

function usage(): never {
  console.error(`usage:
  bro stack push <bead> [--name <stack>]
  bro stack list [<name>]
  bro stack sync [<name>]`)
  process.exit(2)
}

function allBranches(dir: string): string[] {
  return gitTry(['-C', dir, 'branch', '--format=%(refname:short)'])
    .out.split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
}

function localBranch(dir: string, name: string): boolean {
  return gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).code === 0
}

/** Stack name resolution: --name wins, else the current worktree's own
 *  `stack/<name>/…` branch (push from inside a member extends that
 *  stack), else it must be given — guessing a name would scatter
 *  branches across stacks nobody asked for. */
function resolveStackName(argv: string[]): string {
  const explicit = flag(argv, '--name')
  if (explicit !== undefined) {
    if (!isStackName(explicit)) {
      console.error(`error: invalid stack name "${explicit}" ([a-z0-9_.-])`)
      process.exit(2)
    }
    return explicit
  }
  const cur = parseStackBranch(gitTry(['branch', '--show-current']).out.trim())
  if (cur) {
    return cur.name
  }
  console.error('error: no stack context — pass --name <stack>')
  usage()
}

/** The stack tip for a push: the highest-n live member branch. A branch
 *  that merged but still exists is still the right base — its PR-target
 *  diff is computed against it, and `stack sync` retargets after merge. */
export function stackTip(dir: string, name: string): { n: number; base?: string } {
  const members = stackMembers(allBranches(dir), name)
  return { n: nextIndex(members), base: members.at(-1)?.branch }
}

function cmdPush(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS)
  const slug = pos[0]
  if (!slug || !/^[\w.-]+$/.test(slug) || slug.startsWith('-')) {
    console.error('error: push needs a bead/slug ([a-z0-9_.-], not starting with -)')
    usage()
  }
  const name = resolveStackName(argv)
  const main = mainWorktree()
  const defaultRef = defaultBranchName()
  const branches = allBranches(main.path)
  // re-pushing a bead that already sits in the stack re-enters its member
  // branch — push is idempotent, never a duplicate position
  const existing = stackMembers(branches, name).find((m) => m.slug === slug)
  const { n, base } = existing
    ? { n: existing.n, base: readStackEdges().get(existing.branch) }
    : stackTip(main.path, name)
  const branch = existing?.branch ?? formatStackBranch(name, n, slug)
  const r = enterWorktree({
    slug,
    branch,
    base: existing === undefined ? (base ?? main.branch ?? main.head) : undefined,
    main,
    defaultRef,
    allowExisting: existing !== undefined,
  })
  console.log(`worktree ready: ${r.path}  (branch ${r.branch})`)
  console.log(`stack ${name} member ${n} — based on ${r.base ?? base ?? main.branch ?? 'HEAD'}`)
  if (r.stacked) {
    console.log(`open the PR against the parent member: gh pr create --base ${r.base}`)
  }
  if (r.claim.claimed) {
    console.log(`claimed bead ${r.claim.claimed} for this session`)
  } else if (r.claim.refused) {
    console.error(`note: could not claim bead ${slug} — another actor may hold it`)
  }
}

interface MemberView extends SyncMemberInput {
  pr?: number
  worktree?: WorktreeInfo
}

/** Live member state: branch namespace + edges + worktrees + PRs. A
 *  failing host is not fatal — PR fields come back undefined and the
 *  member reads as unmerged, which is the conservative answer for sync. */
function collectMembers(
  name: string,
  root: string,
  rev?: { repo: string; facade: ReviewFacade }
): MemberView[] {
  const edges = readStackEdges()
  const trees = new Map(
    parseWorktreePorcelain(gitTry(['-C', root, 'worktree', 'list', '--porcelain']).out)
      .filter((w) => w.branch !== undefined)
      .map((w) => [w.branch as string, w])
  )
  return stackMembers(allBranches(root), name).map((b) => {
    const w = trees.get(b.branch)
    const dirty = w === undefined || !w.path ? -1 : dirtyCount(w.path)
    const m: MemberView = {
      ...b,
      edgeBase: edges.get(b.branch),
      worktree: w,
      rebaseable: w !== undefined && w.locked === undefined && dirty === 0,
      blocked:
        w === undefined
          ? 'no worktree'
          : w.locked !== undefined
            ? `locked${w.locked ? ` (${w.locked})` : ''}`
            : dirty !== 0
              ? dirty < 0
                ? 'worktree gone'
                : `dirty worktree (${dirty} file(s))`
              : undefined,
    }
    if (rev === undefined) {
      return m
    }
    try {
      const pr = rev.facade.prsForBranch(b.branch)[0]
      if (pr !== undefined) {
        const meta: PrMeta = rev.facade.prMeta({ repo: rev.repo, pr })
        m.pr = pr
        m.prState = meta.state
        m.prBase = meta.baseRef
      }
    } catch {
      // host unreachable mid-sync — member reads as unmerged/untargeted
    }
    return m
  })
}

function resolveReview(root: string): { repo: string; facade: ReviewFacade } | undefined {
  try {
    const facade = reviewHost(root, loadBroConfig(root).connectors)
    return { repo: facade.resolveRepo([]), facade }
  } catch {
    return undefined
  }
}

function cmdList(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS)
  const main = mainWorktree()
  const defaultBase = defaultBranchName() ?? main.branch ?? 'main'
  const branches = allBranches(main.path)
  const names = pos[0] ? [pos[0]] : stackNames(branches)
  if (names.length === 0) {
    console.log('no stacks — `bro stack push <bead> --name <stack>` starts one')
    return
  }
  const rev = resolveReview(main.path)
  for (const name of names) {
    const members = collectMembers(name, main.path, rev)
    console.log(`stack ${name}  (${members.length} member${members.length === 1 ? '' : 's'})`)
    if (members.length === 0) {
      continue
    }
    for (const m of members) {
      const base = displayBase(m, members, defaultBase)
      const stale =
        m.edgeBase !== undefined && m.edgeBase !== defaultBase && !localBranch(main.path, m.edgeBase)
      const wt =
        m.worktree === undefined
          ? 'no-worktree'
          : `${basename(m.worktree.path)} ${stateOfWorktree(m.worktree)}`
      const pr =
        m.pr === undefined
          ? rev === undefined
            ? 'PR?' // no review host resolved — can't tell
            : 'no-PR'
          : `${rev!.facade.prLink(rev!.repo, m.pr)} ${m.prState}→${m.prBase}`
      console.log(`  ${m.n}  ${m.slug}  ${m.branch}  base ${base}${stale ? ' (stale edge)' : ''}  ${wt}  ${pr}`)
    }
  }
}

/** The sync cascade — shared by `stack sync` and `loop --stack`'s
 *  post-merge step. Returns the per-member report lines; never throws on
 *  a single member's failure (a conflict stops that member, not the run). */
export function syncStack(root: string, name: string): string[] {
  const main = mainWorktree()
  const defaultBase = defaultBranchName() ?? main.branch ?? 'main'
  const rev = resolveReview(root)
  const members = collectMembers(name, root, rev)
  const lines: string[] = []
  for (const item of planSync(members, defaultBase)) {
    const m = item.member
    if (m.prState === 'MERGED') {
      removeStackEdge(m.branch)
      lines.push(`  ${m.branch} merged — leaves the chain`)
      continue
    }
    if (item.skip) {
      lines.push(`  ${m.branch} skipped — ${item.skip}`)
      continue
    }
    if (!item.rebase && !item.retarget) {
      continue
    }
    if (item.rebase) {
      const wt = m.worktree!
      // fork point via merge-base — the old base branch may already be
      // deleted, and only member-unique commits must be replayed
      const fork = gitTry(['-C', wt.path, 'merge-base', item.desiredBase, 'HEAD']).out.trim()
      const rb =
        fork === ''
          ? { code: 1, err: `no merge-base with ${item.desiredBase}` }
          : gitTry(['-C', wt.path, 'rebase', '--onto', item.desiredBase, fork])
      if (rb.code !== 0) {
        gitTry(['-C', wt.path, 'rebase', '--abort'])
        lines.push(`  ${m.branch} rebase onto ${item.desiredBase} failed — aborted; owner resolves on enter`)
        continue
      }
      lines.push(`  ${m.branch} rebased onto ${item.desiredBase}`)
      // a rebased branch with an open PR must move the remote head too —
      // retargeting while the remote still carries pre-rebase commits
      // would inflate the PR diff
      if (m.pr !== undefined) {
        const push = gitTry(['-C', wt.path, 'push', '--force-with-lease', 'origin', `HEAD:refs/heads/${m.branch}`])
        if (push.code !== 0) {
          lines.push(`  ${m.branch} push failed — ${push.err || 'remote refused'}; retarget skipped`)
          continue
        }
      }
    }
    if (item.retarget && m.pr !== undefined) {
      if (rev?.facade.retargetPr === undefined) {
        lines.push(`  ${m.branch} — review host cannot retarget PRs; set --base by hand`)
      } else if (rev.facade.retargetPr({ repo: rev.repo, pr: m.pr }, item.desiredBase)) {
        lines.push(`  ${rev.facade.prLink(rev.repo, m.pr)} retargeted → ${item.desiredBase}`)
      } else {
        lines.push(`  ${rev.facade.prLink(rev.repo, m.pr)} retarget refused`)
        continue
      }
    }
    if (item.desiredBase === defaultBase) {
      removeStackEdge(m.branch)
    } else {
      recordStackEdge(m.branch, item.desiredBase)
    }
  }
  return lines
}

function cmdSync(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS)
  const main = mainWorktree()
  const names = pos[0] ? [pos[0]] : stackNames(allBranches(main.path))
  if (names.length === 0) {
    console.log('no stacks — nothing to sync')
    return
  }
  for (const name of names) {
    console.log(`stack ${name}:`)
    const lines = syncStack(main.path, name)
    if (lines.length === 0) {
      console.log('  in sync')
    } else {
      for (const l of lines) {
        console.log(l)
      }
    }
  }
}

export function runStackCommand(argv: string[]): void {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'push':
      return cmdPush(rest)
    case 'list':
      return cmdList(rest)
    case 'sync':
      return cmdSync(rest)
    default:
      usage()
  }
}
