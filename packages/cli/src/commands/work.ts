/**
 * `bro work` — parallel-friendly worktree lifecycle. One linked worktree
 * per task keeps concurrent agent sessions out of each other's working
 * tree; git itself refuses to check out the same branch twice, which is
 * the anti-collision guarantee.
 *
 *   bro work enter <slug> [--branch <name>] [--base <ref>] [--stack]
 *                       sibling checkout <repo>--<slug> on branch work/<slug>;
 *                       --stack (or stack.mode=auto) bases the branch on the
 *                       current worktree's branch — the session's stack head
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  acquireAgentRegistryLock,
  acquireFileLock,
  facade,
  git,
  gitTry,
  loadConfig,
  LockTimeout,
  readAgentRegistry,
  stackSection,
  type Connector,
  type TaskStore,
} from '@broject/core'
import { flag, positionals } from './args.ts'
import { markerLive, ownerTag } from './proc-owner.ts'

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

/** A worktree's real git dir — a linked worktree's `.git` is a FILE
 *  naming `<common>/worktrees/<name>`; the main checkout's `.git` is the
 *  dir itself. Null when neither is readable. Reading the pointer file
 *  beats a `git rev-parse` subprocess on the driver's per-PR hot path. */
export function worktreeGitDir(path: string): string | null {
  const dotgit = join(path, '.git')
  try {
    if (statSync(dotgit).isDirectory()) {
      return dotgit
    }
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'))
    if (m === null) {
      return null
    }
    const d = m[1]!.trim()
    return isAbsolute(d) ? d : resolve(path, d)
  } catch {
    return null
  }
}

/** The claim/retire mutex for one worktree — `<gitdir>/bro/claim.lock`.
 *  `claimWorktree` stamps under it and `bro drive` runs its
 *  occupancy-probe→`worktree remove` / probe→spawn sections under it,
 *  so a dir can't gain an owner while a driver is removing it. Null
 *  when the tree's gitdir can't be resolved. */
export function claimLockPath(path: string): string | null {
  const gd = worktreeGitDir(path)
  return gd === null ? null : join(gd, 'bro', 'claim.lock')
}

/** The freshness horizon for `.work` markers — same as hooks.ts's
 *  LIVE_SESSION_MS: a marker younger than this names a live session. */
export const LIVE_MARKER_MS = 24 * 60 * 60 * 1000

/** The worktree's own claim marker — `<gitdir>/bro/work`, stamped by
 *  `bro work enter` (bro-pywx). Unlike .work marker details it needs no
 *  name matching: presence inside THIS tree is the claim. Returns the
 *  marker detail ('' when fresh but anonymous), undefined when absent
 *  or stale. */
export function worktreeClaim(worktree: string, now: number = Date.now()): string | undefined {
  try {
    const gd = worktreeGitDir(worktree)
    if (gd === null) {
      return undefined
    }
    const marker = join(gd, 'bro', 'work')
    const lines = readFileSync(marker, 'utf8').split('\n')
    if (!markerLive(lines[0], statSync(marker).mtimeMs, LIVE_MARKER_MS, now)) {
      return undefined
    }
    return lines[1]?.trim() ?? ''
  } catch {
    return undefined
  }
}

/** The worktree's own claim marker — `<gitdir>/bro/work`, the in-tree
 *  counterpart of the hooks `.work` markers (bro-pywx). `bro drive`
 *  reads it as occupancy: presence inside THIS worktree is the claim,
 *  no detail-name matching needed — so an owner session is seen even
 *  when its armed detail never named this branch. Advisory: a failed
 *  write must not break enter; the other occupancy planes still apply.
 *  The stamp runs under claimLockPath so `bro drive` can't remove the
 *  tree mid-claim. Returns 'gone' when the tree was retired before the
 *  stamp (callers must not report the dead path as ready),
 *  'lock-timeout' when a live holder outlasted the lock wait (a driver
 *  may still be mid-retire — not ready either), 'skipped' on an
 *  advisory write failure. */
export function claimWorktree(
  path: string,
  detail: string,
  opts: { waitMs?: number } = {}
): 'stamped' | 'gone' | 'lock-timeout' | 'skipped' {
  try {
    const lock = claimLockPath(path)
    if (lock === null) {
      // a missing .git means the tree is gone; a present but
      // unresolvable one is just an unclaimable checkout
      return existsSync(join(path, '.git')) ? 'skipped' : 'gone'
    }
    // The stamp also takes the shared occupancy lock — `bro drive`
    // holds the registry lock across its occupancy-check→spawn/remove
    // sections, so this claim lands before the driver's probe or after
    // the action, never between (bro-qry9). Registry first, claim
    // second — the driver's order. A non-contention failure degrades
    // to claim-lock-only: the stamp is still the occupancy record.
    let releaseShared: () => void = () => {}
    try {
      releaseShared = acquireAgentRegistryLock(path, { waitMs: opts.waitMs })
    } catch (err) {
      if (err instanceof LockTimeout) {
        return 'lock-timeout'
      }
    }
    try {
      const release = acquireFileLock(lock, {
        label: `${basename(path)} claim lock`,
        waitMs: opts.waitMs,
      })
      try {
        // a driver holding the lock just retired the tree — stamping a
        // claim now would resurrect a dead checkout's marker
        if (!existsSync(join(path, '.git'))) {
          return 'gone'
        }
        const gd = worktreeGitDir(path)
        if (gd === null) {
          return 'skipped'
        }
        const dir = join(gd, 'bro')
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'work'),
          `${Date.now()}${ownerTag()}\n${detail}\n`
        )
        return 'stamped'
      } finally {
        release()
      }
    } finally {
      releaseShared()
    }
  } catch (err) {
    // contention is not advisory — a driver holding the claim lock may
    // still retire the tree after we report ready
    if (err instanceof LockTimeout) {
      return 'lock-timeout'
    }
    // advisory — occupancy falls back to the other planes
    return 'skipped'
  }
}

const SLUG_RE = /^\w[\w.-]*$/

function usage(): never {
  console.error(`usage:
  bro work enter <slug> [--branch <name>] [--base <ref>] [--stack]
  bro work leave [slug] [--force] [--delete-branch]
  bro work list
  bro work prune`)
  process.exit(2)
}

export function mainWorktree(): WorktreeInfo {
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
export function dirtyCount(path: string): number {
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
 *  non-bead slugs pass silently; a refused claim (another actor holds the
 *  bead) is reported — the worktree still stands, but the bead isn't ours
 *  and the session's `.task` marker must not read as ownership. */
export function claimBead(slug: string): { claimed?: string; refused?: boolean } {
  // resolve through the configured tasks backend — connectors.tasks
  // pins a non-beads store; the anchor is the git root so a linked
  // worktree or subdirectory resolves the same backend
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd()
  let store: TaskStore
  try {
    store = facade('tasks', { dir: root }, { prefer: loadConfig(root).connectors })
    if (!store.get(slug)) {
      return {}
    }
  } catch {
    return {} // task-store-less repo or a dead store — nothing to say
  }
  try {
    store.claim(slug)
    return { claimed: slug }
  } catch {
    return { refused: true }
  }
}

/** Base ref for a new worktree's branch. `git worktree add` alone would
 *  fork at HEAD — that is accidental stacking whenever enter runs from
 *  a linked worktree. So the base is always explicit: --base wins
 *  outright; --stack (or stack.mode=auto) uses the current worktree's
 *  branch — the session's stack head; otherwise the main checkout's
 *  branch. Nothing to stack on (default branch / detached): auto falls
 *  back to main, an explicit --stack errors. */
export function resolveEnterBase(
  explicit: string | undefined,
  stack: boolean,
  auto: boolean,
  current: string | undefined,
  /** What the main checkout points at — branch name, or its commit sha
   *  when detached. Either way the default base, never ambient HEAD. */
  mainRef: string | undefined,
  /** The repo's default branch name — on a detached main `mainRef` is a
   *  sha, so `current === 'main'` would slip through the check above
   *  and let --stack treat the default branch as a stack head. */
  defaultRef?: string | undefined
): { base?: string; err?: string } {
  if (explicit !== undefined) {
    return { base: explicit }
  }
  if (!current || current === mainRef || current === defaultRef) {
    return stack
      ? { err: '--stack needs a checked-out work branch — detached HEAD and the default branch are not stack heads' }
      : { base: mainRef }
  }
  return stack || auto ? { base: current } : { base: mainRef }
}

/** `<common-git-dir>/bro/stack` — the stack edge dir, shared across every
 *  linked worktree. Null when git can't name the common dir. */
export function stackEdgeDir(): string | null {
  const res = gitTry(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = res.code === 0 ? res.out.trim() : ''
  return common ? join(common, 'bro', 'stack') : null
}

/** `<common-git-dir>/bro/stack-<name>.lock` — the `stack push`
 *  serialization point, held across the plan→create window so two
 *  concurrent pushes can't read the same tip and both mint position n.
 *  Sibling of the edge dir, NOT inside it: readStackEdges maps every
 *  file in bro/stack/ to a branch edge, so a lockfile there would read
 *  as a bogus edge. Null when git can't name the common dir. */
export function stackPushLockPath(name: string): string | null {
  const dir = stackEdgeDir()
  return dir === null ? null : join(dirname(dir), `stack-${encodeURIComponent(name)}.lock`)
}

/** Stacked branches record their base so stack sync / cleanup can derive
 *  merge order bottom-up. The edge lives in the common git dir —
 *  visible from every linked worktree. One file per branch,
 *  create-only, advisory. */
export function recordStackEdge(branch: string, base: string): void {
  const dir = stackEdgeDir()
  if (!dir) {
    return
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, encodeURIComponent(branch)), `${base}\n`)
  } catch {
    // advisory record — a failed write must not break enter
  }
}

/** Every recorded edge, branch → base. Stale entries (dead branches) are
 *  the reader's call — the file is advisory, reconciliation lives in
 *  `bro stack list`/`sync`. */
export function readStackEdges(): Map<string, string> {
  const out = new Map<string, string>()
  const dir = stackEdgeDir()
  if (!dir) {
    return out
  }
  try {
    for (const f of readdirSync(dir)) {
      const base = readFileSync(join(dir, f), 'utf8').trim()
      if (base !== '') {
        out.set(decodeURIComponent(f), base)
      }
    }
  } catch {
    // no edge dir yet, or unreadable — same answer: no edges
  }
  return out
}

/** Stack sync retargets a member onto the default branch — the edge is
 *  absence, so a stale file must go or the member reads as still-stacked. */
export function removeStackEdge(branch: string): void {
  const dir = stackEdgeDir()
  if (!dir) {
    return
  }
  try {
    rmSync(join(dir, encodeURIComponent(branch)), { force: true })
  } catch {
    // advisory — a failed remove must not break sync
  }
}

function stackMode(): 'auto' | 'manual' {
  try {
    const cfg = loadConfig(process.cwd(), { stack: stackSection }) as {
      stack?: { mode?: string }
    }
    return cfg.stack?.mode === 'auto' ? 'auto' : 'manual'
  } catch {
    return 'manual'
  }
}

// submodules are not populated by worktree add — a fresh tree without
// them builds stale or fails; init is best-effort (network may be down)
export function initSubmodules(path: string): void {
  if (!hasSubmodules(path)) {
    return
  }
  const sub = gitTry(['-C', path, 'submodule', 'update', '--init', '--recursive'])
  console.log(
    sub.code === 0
      ? 'submodules initialized'
      : `warning: submodule init failed — ${sub.err || 'check .gitmodules'}`
  )
}

/** Everything that decides where the new branch forks from. */
function enterBase(argv: string[], main: WorktreeInfo): { base?: string } {
  const { base, err } = resolveEnterBase(
    flag(argv, '--base'),
    argv.includes('--stack'),
    stackMode() === 'auto',
    gitTry(['branch', '--show-current']).out.trim() || undefined,
    main.branch ?? main.head,
    defaultBranchName()
  )
  if (err) {
    console.error(`error: ${err}`)
    process.exit(1)
  }
  return { base }
}

/** The default branch name regardless of the main checkout's attachment
 *  — a detached main reports `mainRef` as a sha, which must not make an
 *  explicit `--base main` record a stack edge an attached main wouldn't.
 *  Remote-agnostic: origin/HEAD is asked first, then any other remote's
 *  HEAD — a repo whose primary remote isn't 'origin' gets the same
 *  protection. */
export function defaultBranchName(): string | undefined {
  const remotes = ['origin', ...gitTry(['remote']).out.split('\n').filter(Boolean)]
  for (const r of new Set(remotes)) {
    const head = gitTry(['symbolic-ref', '--short', `refs/remotes/${r}/HEAD`])
    if (head.code === 0) {
      return head.out.trim().replace(/^[^/]+\//, '')
    }
  }
  return undefined
}

export interface EnterWorktreeResult {
  path: string
  branch: string
  base?: string
  /** base is a real local branch other than main — a stack edge was
   *  recorded for bottom-up merge order */
  stacked: boolean
  claim: { claimed?: string; refused?: boolean }
  /** the worktree vanished between `worktree add` and the claim stamp —
   *  a `bro drive` retire won the claim lock. Callers must abort rather
   *  than report the dead path as ready */
  gone?: boolean
  /** the claim-lock wait expired on a live holder — a driver may still
   *  be mid-retire, so callers must abort rather than report ready */
  claimLockTimedOut?: boolean
  /** set with claimLockTimedOut: the just-added tree was retired so a
   *  retry doesn't die on 'path already exists' (bro-0fiq). Absent/false
   *  means the tree is still there — occupied, or removal failed. */
  partialRemoved?: boolean
}

export interface EnterWorktreeOpts {
  slug: string
  branch: string
  base?: string
  main: WorktreeInfo
  defaultRef?: string
  allowExisting?: boolean
  reusePath?: boolean
  /** claim-stamp lock wait — tests bound it; production uses the
   *  default (the 20s shared-lock/claim-lock bound). */
  claimWaitMs?: number
}

export interface WorktreeCreateResult {
  path: string
  branch: string
  branchExists: boolean
  /** The target dir already stood on the target branch — stack push's
   *  idempotent re-enter; no `worktree add` ran. */
  reused: boolean
  /** base is a real local branch other than main — a stack edge was
   *  recorded for bottom-up merge order. Recorded HERE, not in
   *  finishWorktreeEnter, so a same-slug re-push entering under the push
   *  lock always observes the edge the first push minted. */
  stacked: boolean
}

/** The create half of `enterWorktree` — split out so `stack push` holds
 *  its push lock across exactly the plan→create window and runs the
 *  slower post-add steps outside it. Adds the sibling worktree (or
 *  checks out an existing branch); `allowExisting` gates whether an
 *  already-existing target branch is checked out or refused;
 *  `reusePath` additionally lets an existing worktree dir be reused —
 *  only when it is checked out on the target branch AND is this repo's
 *  (same common git dir — an unrelated checkout that happens to sit on
 *  the same branch name is not this stack's member). */
export function createWorktree(opts: EnterWorktreeOpts): WorktreeCreateResult {
  const { slug, branch, base, main, defaultRef, allowExisting = true, reusePath = false } = opts
  const path = worktreePathFor(main.path, slug)
  if (existsSync(path)) {
    const onBranch = gitTry(['-C', path, 'branch', '--show-current']).out.trim()
    const commonOf = (dir: string) =>
      gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']).out.trim()
    const sameRepo = commonOf(path) !== '' && commonOf(path) === commonOf(main.path)
    if (reusePath && onBranch === branch && sameRepo) {
      return { path, branch, branchExists: true, reused: true, stacked: false }
    }
    console.error(`error: ${path} already exists`)
    process.exit(1)
  }
  // an existing branch under the target name means the slug names an
  // in-flight task — check it out rather than failing on -b. The
  // resolved default base is irrelevant here.
  const branchExists = gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
  if (branchExists && !allowExisting) {
    console.error(`error: ${branch} already exists`)
    process.exit(1)
  }
  const args = ['worktree', 'add', path]
  if (branchExists) {
    args.push(branch)
  } else {
    args.push('-b', branch)
    if (base) {
      args.push(base)
    }
  }
  const res = gitTry(args)
  if (res.code !== 0) {
    console.error(`error: git worktree add failed — ${res.err}`)
    process.exit(1)
  }
  // a stack edge is only a real edge when the base is a local branch —
  // a raw commit-ish (--base abc123 / origin/main) yields no merge order.
  // The edge records HERE, right after the add: it is part of the
  // plan→create window — a re-push of the same slug holds the push lock
  // until it lands, and must observe the member as stacked.
  const stacked =
    base !== undefined &&
    base !== (main.branch ?? main.head) &&
    base !== defaultRef &&
    gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]).code === 0
  if (stacked && !branchExists) {
    recordStackEdge(branch, base)
  }
  return { path, branch, branchExists, reused: false, stacked }
}

/** The post-add half of `enterWorktree` — claim marker, submodule init,
 *  bead claim. Safe outside the push lock: the branch AND its stack
 *  edge exist once createWorktree returns, so a racing push already
 *  sees the fully-minted position. */
export function finishWorktreeEnter(
  opts: EnterWorktreeOpts,
  created: WorktreeCreateResult
): EnterWorktreeResult {
  const { slug, branch, base } = opts
  const { path } = created
  const stamp = claimWorktree(path, slug, { waitMs: opts.claimWaitMs })
  if (stamp === 'gone') {
    // a driver retired the tree between the add and the stamp — claiming
    // the bead and reporting success would strand both on a dead path
    return { path, branch, stacked: false, claim: {}, gone: true }
  }
  if (stamp === 'lock-timeout') {
    // a fresh tree left behind dies the retry on 'path already exists'
    // (bro-0fiq) — retire it unless an agent provably moved in during
    // the lock wait (its registry entry pins this path as worktree);
    // evicting a live fixer is worse than leaving the dir. A reused
    // tree is never ours to remove. The check→remove runs under the
    // shared occupancy lock — without it a claimant could pin this path
    // after the check and lose its live tree to the remove. A holder
    // past the bound is itself a claimant mid-act → keep the tree.
    let partialRemoved = false
    if (!created.reused) {
      try {
        const releaseOcc = acquireAgentRegistryLock(opts.main.path)
        try {
          // the registry pins agent occupants; the in-tree claim marker
          // pins a session that won a `work enter`/`stack push` stamp
          // during our wait — neither is visible in the other plane
          const movedIn =
            Object.values(readAgentRegistry(opts.main.path)).some(
              (e) =>
                typeof e.worktree === 'string' && resolve(e.worktree) === resolve(path)
            ) || worktreeClaim(path) !== undefined
          partialRemoved =
            !movedIn &&
            gitTry(['-C', opts.main.path, 'worktree', 'remove', '--force', path])
              .code === 0
        } finally {
          releaseOcc()
        }
      } catch {
        // occupancy lock contended past the bound — keep the tree
      }
    }
    return { path, branch, stacked: false, claim: {}, claimLockTimedOut: true, partialRemoved }
  }
  if (created.reused) {
    const edgeBase = readStackEdges().get(branch)
    return { path, branch, base: edgeBase, stacked: edgeBase !== undefined, claim: claimBead(slug) }
  }
  initSubmodules(path)
  return { path, branch, base, stacked: created.stacked, claim: claimBead(slug) }
}

/** The worktree-add core shared by `work enter` and `stack push` — the
 *  caller resolves branch/base; this adds the sibling worktree (or
 *  checks out an existing branch), inits submodules, claims a bead-named
 *  slug, and records the stack edge last so a failure mid-way never
 *  leaves a half-registered member. */
export function enterWorktree(opts: EnterWorktreeOpts): EnterWorktreeResult {
  return finishWorktreeEnter(opts, createWorktree(opts))
}

function cmdEnter(argv: string[]): void {
  const pos = positionals(argv, new Set(['--branch', '--base']))
  const slug = pos[0]
  if (!slug || !SLUG_RE.test(slug)) {
    console.error('error: enter needs a slug ([a-z0-9_.-], not starting with -)')
    usage()
  }
  const branch = flag(argv, '--branch') ?? `work/${slug}`
  const main = mainWorktree()
  const defaultRef = defaultBranchName()
  const { base } = enterBase(argv, main)
  const branchExists = gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
  if (branchExists && (flag(argv, '--base') !== undefined || argv.includes('--stack'))) {
    console.error(`error: --base/--stack only apply when creating the branch; ${branch} already exists`)
    process.exit(1)
  }
  const r = enterWorktree({ slug, branch, base, main, defaultRef })
  if (r.claimLockTimedOut) {
    console.error(
      `error: claim lock for ${r.path} timed out — ` +
        (r.partialRemoved === true
          ? 'removed the partial worktree; retry enter'
          : `worktree left at ${r.path} — inspect it before retrying`)
    )
    process.exit(1)
  }
  if (r.gone) {
    console.error(`error: ${r.path} was retired before the claim could land — nothing to enter`)
    process.exit(1)
  }
  console.log(`worktree ready: ${r.path}  (branch ${r.branch})
  cd ${r.path}
note: gitignored dirs (node_modules, dist) are not shared — install deps there`)
  if (r.stacked) {
    console.log(`stacked on ${base} — merge order runs bottom-up`)
  }
  if (r.claim.claimed) {
    console.log(`claimed bead ${r.claim.claimed} for this session`)
  } else if (r.claim.refused) {
    console.error(`note: could not claim bead ${slug} — another actor may hold it`)
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

/** Pre-remove guards git can no longer provide once we stack --force for
 *  submodule trees: locked is explicit human intent (unlock first), and
 *  an on-disk tree that can't be verified clean is NOT clean. */
function assertRemovable(target: WorktreeInfo, force: boolean): void {
  if (target.locked !== undefined) {
    const why = target.locked ? ` (${target.locked})` : ''
    console.error(`error: ${target.path} is locked${why} — run \`git worktree unlock\` first`)
    process.exit(1)
  }
  const dirty = dirtyCount(target.path)
  if (!force && (dirty > 0 || (dirty < 0 && existsSync(target.path)))) {
    const why = dirty > 0 ? 'has uncommitted changes' : 'could not be verified clean'
    console.error(`error: ${target.path} ${why} (use --force to override)`)
    process.exit(1)
  }
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
  assertRemovable(target, force)
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

export function stateOfWorktree(w: WorktreeInfo): string {
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
    const parts = [i === 0 ? 'main' : 'linked', w.path, refLabel(w), stateOfWorktree(w)]
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

/** The work connector — git worktrees as lifecycle state: a session in
 *  the primary checkout gets the parallel-friendly nudge, sibling
 *  worktrees surface under parallel work, and an armed session stopping
 *  inside a dirty linked worktree blocks until it's clean or left. */
export const workConnector: Connector = {
  name: 'work',
  hooks: () => ({
    sessionStart(ctx) {
      try {
        const gd = gitDirOf(ctx.dir)
        if (!gd || isLinkedGitDir(gd)) {
          return []
        }
        return [
          'parallel-friendly: run work in a linked worktree — `bro work enter <slug>`; finish with `bro work leave`; `bro work list` shows siblings',
        ]
      } catch {
        return []
      }
    },
    parallelWork(ctx) {
      try {
        const cur = gitTry(['-C', ctx.dir, 'rev-parse', '--show-toplevel']).out.trim()
        return parseWorktreePorcelain(
          gitTry(['-C', ctx.dir, 'worktree', 'list', '--porcelain']).out
        )
          .slice(1) // porcelain lists the main worktree first
          .filter((w) => !w.prunable && w.path !== cur)
          .slice(0, 5)
          .map((w) => `worktree ${basename(w.path)} [${w.branch ?? 'detached'}]`)
      } catch {
        return []
      }
    },
    stopGate(ctx) {
      try {
        const gd = gitDirOf(ctx.dir)
        if (!gd || !isLinkedGitDir(gd)) {
          return []
        }
        const res = gitTry(['-C', ctx.dir, 'status', '--porcelain'])
        const dirty = res.code === 0 ? res.out.split('\n').filter(Boolean).length : 0
        return [
          {
            aspect: 'work',
            block:
              dirty > 0
                ? `bro: linked worktree has ${dirty} uncommitted file(s) — ` +
                  'commit/push the work or discard deliberately, then `bro work leave`'
                : undefined,
            armedHint: 'bro: still inside a linked worktree — `bro work leave` when done',
          },
        ]
      } catch {
        return []
      }
    },
  }),
}
