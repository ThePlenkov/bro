/**
 * `bro work` — parallel-friendly worktree lifecycle. One linked worktree
 * per task keeps concurrent agent sessions out of each other's working
 * tree; git itself refuses to check out the same branch twice, which is
 * the anti-collision guarantee.
 *
 *   bro work enter <slug> [--branch <name>] [--base <ref>]
 *                       sibling checkout <repo>--<slug> on branch work/<slug>
 *   bro work leave [slug] [--force] [--delete-branch]
 *                       remove a worktree — current one by default
 *   bro work list       worktrees with branch, dirty state, disk usage
 *   bro work prune      drop admin entries for worktrees already gone
 *
 * Layout: worktrees are SIBLINGS of the main checkout (`<repo>--<slug>`),
 * never nested inside it — nothing to gitignore, and a wiped parent
 * doesn't strand children. Beads sessions still share one database: bd
 * discovers `.beads` through the git common dir regardless of how the
 * worktree was created.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { bdTry, git, gitTry } from '@bro/core'
import { flag, positionals } from './args.ts'

export interface WorktreeInfo {
  path: string
  head: string
  /** branch shortname; undefined when detached/bare */
  branch?: string
  bare: boolean
  detached: boolean
  /** admin entry exists but the directory is gone — `git worktree prune` bait */
  prunable?: string
  /** locked against removal — porcelain carries `locked` or `locked <reason>` */
  locked?: string
}

/** Git C-quotes unusual paths in porcelain output — unwrap and unescape. */
export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path
  }
  return path.slice(1, -1).replace(/\\(.)/g, (_, c: string) => {
    if (c === 'n') return '\n'
    if (c === 't') return '\t'
    return c // covers \\, \", and any other escape — take literally
  })
}

/** `git worktree list --porcelain` → entries. The first entry is always
 *  the main worktree — linked ones follow. */
export function parseWorktreePorcelain(text: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  let cur: WorktreeInfo | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: unquoteGitPath(line.slice('worktree '.length)), head: '', bare: false, detached: false }
      out.push(cur)
    } else if (!cur) {
      continue
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      cur.branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line === 'detached') {
      cur.detached = true
    } else if (line.startsWith('prunable ')) {
      cur.prunable = line.slice('prunable '.length)
    } else if (line === 'locked') {
      cur.locked = ''
    } else if (line.startsWith('locked ')) {
      cur.locked = line.slice('locked '.length)
    }
  }
  return out
}

/** A linked worktree's git dir is exactly `<main>/.git/worktrees/<name>` —
 *  the primary checkout's git dir never is. Anchoring on `.git/worktrees/`
 *  keeps a primary checkout living under a `…/worktrees/…` directory from
 *  being misclassified as linked. */
export function isLinkedGitDir(gitDir: string): boolean {
  const norm = gitDir.split(sep).join('/')
  return /(?:^|\/)\.git\/worktrees\/[^/]+$/.test(norm)
}

/** Slug → sibling path next to the main checkout: `bro` + `fix-x` →
 *  `../bro--fix-x`. */
export function worktreePathFor(mainRoot: string, slug: string): string {
  return join(dirname(mainRoot), `${basename(mainRoot)}--${slug}`)
}

const SLUG_RE = /^\w[\w.-]*$/

function usage(): never {
  console.error(`usage:
  bro work enter <slug> [--branch <name>] [--base <ref>]
  bro work leave [slug] [--force] [--delete-branch]
  bro work list
  bro work prune`)
  process.exit(2)
}

function mainWorktree(): WorktreeInfo {
  const all = parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
  const main = all[0]
  if (!main) {
    console.error('bro work: not inside a git worktree')
    process.exit(1)
  }
  return main
}

function currentRoot(): string {
  return git(['rev-parse', '--show-toplevel']).trim()
}

/** Dirty-file count in a worktree, or -1 when the path is gone. */
function dirtyCount(path: string): number {
  const res = gitTry(['-C', path, 'status', '--porcelain'])
  if (res.code !== 0) {
    return -1
  }
  return res.out.split('\n').filter(Boolean).length
}

function diskUsage(path: string): string {
  const du = spawnSync('du', ['-sh', path], { encoding: 'utf8' }) // NOSONAR — fixed args, path is a string arg not a shell fragment
  return du.status === 0 ? (du.stdout ?? '').split('\t')[0]!.trim() : '?'
}

/** The repo declares submodules — git worktree add does NOT populate them,
 *  and `worktree remove` refuses a tree that still contains one. */
export function hasSubmodules(worktreePath: string): boolean {
  return existsSync(join(worktreePath, '.gitmodules'))
}

/** Best-effort claim: when the slug names a real bead, mark it in_progress
 *  for this actor so parallel sessions see it taken. Beads-less repos and
 *  non-bead slugs pass silently. */
function claimBead(slug: string): string | null {
  if (bdTry(['show', slug]).code !== 0) {
    return null
  }
  const upd = bdTry(['update', slug, '--claim'])
  return upd.code === 0 ? slug : null
}

function cmdEnter(argv: string[]): void {
  const pos = positionals(argv, new Set(['--branch', '--base']))
  const slug = pos[0]
  if (!slug || !SLUG_RE.test(slug)) {
    console.error('error: enter needs a slug ([a-z0-9_.-], not starting with -)')
    usage()
  }
  const branch = flag(argv, '--branch') ?? `work/${slug}`
  const base = flag(argv, '--base')
  const main = mainWorktree()
  const path = worktreePathFor(main.path, slug)
  if (existsSync(path)) {
    console.error(`error: ${path} already exists`)
    process.exit(1)
  }
  // an existing branch under the target name means the slug names an
  // in-flight task — check it out rather than failing on -b
  const branchExists = gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
  if (branchExists && base) {
    console.error(`error: --base only applies when creating the branch; ${branch} already exists`)
    process.exit(1)
  }
  const args = ['worktree', 'add', path]
  if (branchExists) {
    args.push(branch)
  } else {
    args.push('-b', branch)
  }
  if (base) {
    args.push(base)
  }
  const res = gitTry(args)
  if (res.code !== 0) {
    console.error(`error: git worktree add failed — ${res.err}`)
    process.exit(1)
  }
  // submodules are not populated by worktree add — a fresh tree without
  // them builds stale or fails; init is best-effort (network may be down)
  if (hasSubmodules(path)) {
    const sub = gitTry(['-C', path, 'submodule', 'update', '--init', '--recursive'])
    console.log(
      sub.code === 0
        ? 'submodules initialized'
        : `warning: submodule init failed — ${sub.err || 'check .gitmodules'}`
    )
  }
  const claimed = claimBead(slug)
  console.log(`worktree ready: ${path}  (branch ${branch})
  cd ${path}
note: gitignored dirs (node_modules, dist) are not shared — install deps there`)
  if (claimed) {
    console.log(`claimed bead ${claimed} for this session`)
  }
}

/** A positional can be a path, a basename, or a bare slug. Resolving the
 *  current root must happen before removal — afterwards `rev-parse` can't
 *  run in the deleted cwd. */
function resolveLeaveTarget(
  all: WorktreeInfo[],
  main: WorktreeInfo,
  selector: string | undefined
): { target: WorktreeInfo; wasCurrent: boolean } {
  const cur = selector ? undefined : currentRoot()
  const target = selector
    ? all.find((w) => w.path === resolve(selector) || basename(w.path) === selector || w.path === worktreePathFor(main.path, selector))
    : all.find((w) => w.path === cur)
  if (!target) {
    const what = selector ? `matching "${selector}"` : 'at the current directory'
    console.error(`error: no worktree ${what}`)
    process.exit(1)
  }
  if (target.path === main.path) {
    console.error('error: refusing to remove the main worktree')
    process.exit(1)
  }
  return { target, wasCurrent: target.path === cur }
}

function cmdLeave(argv: string[]): void {
  const pos = positionals(argv, new Set())
  const force = argv.includes('--force')
  const deleteBranch = argv.includes('--delete-branch')
  const all = parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
  const main = all[0]
  if (!main) {
    console.error('bro work: not inside a git worktree')
    process.exit(1)
  }
  const { target, wasCurrent } = resolveLeaveTarget(all, main, pos[0])
  // locked is explicit human intent — no flag of ours should override it
  if (target.locked !== undefined) {
    const why = target.locked ? ` (${target.locked})` : ''
    console.error(`error: ${target.path} is locked${why} — run \`git worktree unlock\` first`)
    process.exit(1)
  }
  // git's own dirty-tree refusal is our safety net — but submodule trees
  // need --force, which would silence it. Check dirt ourselves first;
  // an unverifiable tree (-1 while still on disk) is NOT clean.
  const dirty = dirtyCount(target.path)
  if (!force && (dirty > 0 || (dirty < 0 && existsSync(target.path)))) {
    const why = dirty > 0 ? 'has uncommitted changes' : 'could not be verified clean'
    console.error(`error: ${target.path} ${why} (use --force to override)`)
    process.exit(1)
  }
  const args = ['-C', main.path, 'worktree', 'remove', target.path]
  if (force) {
    args.push('--force')
  }
  // submodule config is shared across worktrees — deinit here would
  // unregister them for everyone. git's documented escape is a second
  // --force; safe to stack now that locked trees are refused above.
  if (hasSubmodules(target.path)) {
    args.push('--force')
  }
  const res = gitTry(args)
  if (res.code !== 0) {
    console.error(`error: git worktree remove failed — ${res.err} (use --force to override)`)
    process.exit(1)
  }
  const gone = wasCurrent ? ` — this directory is gone; cd ${main.path}` : ''
  console.log(`removed worktree ${target.path}${gone}`)
  if (deleteBranch && target.branch) {
    const del = gitTry(['-C', main.path, 'branch', '-d', target.branch])
    console.log(
      del.code === 0
        ? `deleted branch ${target.branch}`
        : `kept branch ${target.branch} (${del.err || 'not merged'})`
    )
  }
}

function stateLabel(w: WorktreeInfo): string {
  if (w.locked !== undefined) {
    return 'LOCKED'
  }
  if (w.prunable) {
    return 'PRUNABLE'
  }
  const dirty = existsSync(w.path) ? dirtyCount(w.path) : -1
  if (dirty < 0) {
    return 'gone'
  }
  return dirty === 0 ? 'clean' : `dirty(${dirty})`
}

function refLabel(w: WorktreeInfo): string {
  if (w.branch) {
    return w.branch
  }
  const head = w.head.slice(0, 8)
  return w.detached ? `detached@${head}` : head
}

function cmdList(argv: string[]): void {
  const withSizes = argv.includes('--sizes')
  const all = parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
  const main = all[0]
  for (const [i, w] of all.entries()) {
    const parts = [i === 0 ? 'main' : 'linked', w.path, refLabel(w), stateLabel(w)]
    if (withSizes && existsSync(w.path)) {
      parts.push(diskUsage(w.path))
    }
    if (i === 0) {
      parts.push(`[${basename(main.path)}]`)
    }
    console.log(parts.join('  '))
  }
}

function cmdPrune(): void {
  const before = parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
  const prunable = before.filter((w) => w.prunable)
  const res = gitTry(['worktree', 'prune', '--verbose'])
  for (const line of res.out.split('\n').filter(Boolean)) {
    console.log(line)
  }
  if (res.code !== 0) {
    console.error(`error: git worktree prune failed — ${res.err}`)
    process.exit(1)
  }
  if (prunable.length > 0) {
    const plural = prunable.length === 1 ? 'y' : 'ies'
    console.log(`pruned ${prunable.length} stale entr${plural}`)
  } else {
    console.log('nothing stale — all worktrees present on disk')
  }
}

export function runWorkCommand(argv: string[]): void {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'enter':
      return cmdEnter(rest)
    case 'leave':
      return cmdLeave(rest)
    case 'list':
      return cmdList(rest)
    case 'prune':
      return cmdPrune()
    default:
      usage()
  }
}

/** Absolute git dir for cwd — used by hooks to tell linked worktrees from
 *  the primary checkout without re-parsing `worktree list`. */
export function gitDirOf(cwd: string): string | null {
  const res = spawnSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { // NOSONAR — git is a required runtime dep; fixed argv
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (res.status !== 0) {
    return null
  }
  const dir = (res.stdout ?? '').trim()
  return dir ? resolve(dir) : null
}
