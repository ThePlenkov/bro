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
 *   bro work prune      drop admin entries for worktrees already gone;
 *                       --loop also reaps loop/* (+stack/*) litter whose
 *                       bead closed or PR merged, releases in_progress
 *                       claims whose worker is dead, re-registers ghost
 *                       sibling dirs, and caps the parked resume cache —
 *                       --dry-run reports the verdicts
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
  agentRegistryPath,
  facade,
  git,
  gitTry,
  loadConfig,
  LockTimeout,
  pidAlive,
  readAgentRegistry,
  reviewHost,
  stackSection,
  type AgentRegistryEntry,
  type Connector,
  type ReviewFacade,
  type TaskRow,
  type TaskStore,
} from '@broject/core'
import { loopSection, loopSlug, type LoopConfig } from '@broject/loop'
import { listWatches, type ListedWatch } from '@broject/act'
import { parseStackBranch } from '@broject/stack'
import { flag, positionals } from './args.ts'
import {
  agentProcessesIn,
  detailMatches,
  hooksDirOf,
  LIVE_MARKER_MS,
  liveWorkDetails,
  markerLive,
  ownerTag,
  registryEntryHoldsClaim,
} from './proc-owner.ts'
import { collectLoopRuns, type LoopRunView } from './loop-state.ts'
export { LIVE_MARKER_MS }

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
  bro work prune [--loop] [--dry-run]`)
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

/** git's own stale-admin prune — missing-dir entries whose metadata
 *  alone is litter. A failed prune is fatal: the report would be fiction. */
function pruneStaleEntries(): void {
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

/** tasks + review facades for the litter sweep — either may be absent.
 *  The sweep degrades on a missing review host (closed-bead + clean
 *  still reaps and branches fall back to git's own merged check); a
 *  missing task store means no verdict record, so nothing is provably
 *  done and the sweep is skipped outright. */
function litterFacades(root: string): {
  tasks?: TaskStore
  rev?: { repo: string; facade: ReviewFacade }
} {
  // core loadConfig, not loadBroConfig: this file is imported by
  // plugins.ts for workConnector — importing back would TDZ-crash any
  // entry that evaluates work.ts first (unit tests do)
  const prefer = loadConfig(root).connectors
  let tasks: TaskStore | undefined
  try {
    tasks = facade('tasks', { dir: root }, { prefer })
  } catch (err) {
    console.error(`work prune --loop: no task store (${err instanceof Error ? err.message : err}) — bead state unverifiable`)
  }
  let rev: { repo: string; facade: ReviewFacade } | undefined
  try {
    const f = reviewHost(root, prefer)
    rev = { repo: f.resolveRepo([]), facade: f }
  } catch {
    // no review host — the PR pass is skipped
  }
  return { tasks, rev }
}

/** The sweep's human report — released/repaired/reaped/deleted/kept
 *  lines, errors to stderr, and the count summary. */
function printLitterReport(rep: LitterReap, dry: boolean): void {
  for (const r of rep.released) {
    console.log(`  ${dry ? 'would release' : 'released'} claim ${r}`)
  }
  for (const g of rep.repaired) {
    console.log(`  ${dry ? 'would re-register' : 're-registered'} ${g}`)
  }
  for (const r of rep.reaped) {
    console.log(`  ${dry ? 'would reap' : 'reaped'} ${r}`)
  }
  for (const b of rep.branches) {
    console.log(`  ${dry ? 'would delete' : 'deleted'} branch ${b}`)
  }
  for (const k of rep.kept) {
    console.log(`  kept ${k}`)
  }
  for (const e of rep.errors) {
    console.error(`  error: ${e}`)
  }
  console.log(`  loop litter: ${rep.reaped.length} ${dry ? 'would be ' : ''}reaped, ${rep.kept.length} kept`)
}

function cmdPrune(argv: string[]): void {
  const pos = positionals(argv, new Set(), {
    boolFlags: new Set(['--loop', '--dry-run']),
    strict: true,
  })
  if (pos.length > 0) {
    usage()
  }
  pruneStaleEntries()
  if (!argv.includes('--loop')) {
    return
  }
  // the litter sweep — same predicate the loop audit reaps on: bead
  // closed (or a merged PR names the branch) + verifiably clean
  const dry = argv.includes('--dry-run')
  const main = mainWorktree()
  const { tasks, rev } = litterFacades(main.path)
  if (tasks === undefined) {
    return
  }
  // core loadConfig (see litterFacades) — the parked-cache knobs ride
  // the loop section
  const loop = loadConfig(main.path, { loop: loopSection }).loop as LoopConfig | undefined
  printLitterReport(
    reapLoopLitter({
      root: main.path,
      tasks,
      rev,
      stackPrefix: 'stack/',
      dryRun: dry,
      parkedKeep: loop?.parkedKeep,
      parkedTtlDays: loop?.parkedTtlDays,
    }),
    dry
  )
}

// --- merged-work retirement ---------------------------------------------------
//
// The guards for retiring local work the host says landed: a worktree
// only goes when verifiably clean, a branch only when its tip is provably
// inside the merged head. `act merge --cleanup`, `bro drive`'s post-merge
// retirement, and the loop-litter sweep all share them — `bro work` owns
// the worktree lifecycle (spec bro-dgp), so the primitives live here.

/** `tip` reachable from `oid` — only meaningful when the oid object is
 *  present locally (merged heads on deleted remote branches may not be). */
export function isAncestor(tip: string, oid: string): boolean {
  if (gitTry(['cat-file', '-e', oid]).code !== 0) {
    return false
  }
  return gitTry(['merge-base', '--is-ancestor', tip, oid]).code === 0
}

/** Remove the linked worktree the merged branch was checked out in,
 *  via the main checkout. Returns false when the tree must be kept —
 *  locked (explicit human intent; `work leave` holds the same line even
 *  under --force), dirty/unverifiable, or the removal itself failed.
 *  `worktree remove` refuses trees with ANY extra files (even ignored
 *  ones like node_modules), so a clean porcelain status — no tracked
 *  modifications, no untracked files — is the guard for --force being
 *  safe: only ignored debris remains. The check is config-independent
 *  (`-c status.showUntrackedFiles=all` overrides a user config that
 *  would hide untracked files) and fail-closed. */
export function removeMergedWorktree(root: string, here: WorktreeInfo, main: WorktreeInfo): boolean {
  if (here.locked !== undefined) {
    const why = here.locked ? ` (${here.locked})` : ''
    console.error(`cleanup: ${root} is locked${why} — worktree kept; unlock with \`git worktree unlock\``)
    return false
  }
  const status = gitTry(['-c', 'status.showUntrackedFiles=all', '-C', root, 'status', '--porcelain'])
  if (status.code !== 0 || status.out.trim() !== '') {
    console.error(
      status.code !== 0
        ? `cleanup: cannot verify ${root} is clean (${status.err}) — worktree kept`
        : `cleanup: ${root} has uncommitted changes — worktree kept`
    )
    return false
  }
  // initialized submodules need a second --force to override
  const force = hasSubmodules(root) ? ['--force', '--force'] : ['--force']
  const res = gitTry(['-C', main.path, 'worktree', 'remove', ...force, root])
  if (res.code !== 0) {
    console.error(`cleanup: worktree ${root} not removed (${res.err})`)
    return false
  }
  process.chdir(main.path) // cwd is gone — git ops below need a live dir
  console.log(`cleanup: removed worktree ${root}`)
  console.log(`cleanup: cd ${main.path}`)
  return true
}

/** Best-effort local-side branch retire after a merge — deletes only
 *  when the local tip IS the merged head (or its ancestor): a same-named
 *  branch with extra commits is kept. `update-ref -d <ref> <tip>` is a
 *  compare-and-delete — commits landing between the check and the delete
 *  can't be silently dropped. */
export function deleteMergedLocalBranch(headRef: string, headSha: string): void {
  // a prunable entry (directory already gone) still lists its branch —
  // it must not count as checked out or the branch is never deleted
  const checkedOut = parseWorktreePorcelain(gitTry(['worktree', 'list', '--porcelain']).out).some(
    (w) => w.branch === headRef && w.prunable === undefined && existsSync(w.path)
  )
  if (checkedOut) {
    console.error(`cleanup: ${headRef} is checked out — delete it after switching`)
    return
  }
  const tipRes = gitTry(['rev-parse', '--verify', `refs/heads/${headRef}`])
  if (tipRes.code !== 0) {
    return // no local branch — nothing to do
  }
  const tip = tipRes.out.trim()
  if (tip !== headSha && !isAncestor(tip, headSha)) {
    console.error(`cleanup: ${headRef} has commits beyond the merged head — kept`)
    return
  }
  const res = gitTry(['update-ref', '-d', `refs/heads/${headRef}`, tip])
  if (res.code === 0) {
    console.log(`cleanup: deleted local branch ${headRef}`)
  } else if (/checked out/i.test(res.err)) {
    console.error(`cleanup: ${headRef} is checked out — delete it after switching`)
  } else if (/cannot lock ref/i.test(res.err)) {
    console.error(`cleanup: ${headRef} moved past the verified tip — kept`)
  } else {
    console.error(`cleanup: local branch ${headRef} not deleted (${res.err})`)
  }
}

// --- loop/stack litter sweep ----------------------------------------------------
//
// Loop worktrees are disposable by design: the bead's status is the
// verdict record (closed = landed or verdict-closed), the worktree just
// the scratch dir it happened in. A completed loop used to audit its
// tails without removing them — orphaned bro--bro-* dirs accumulated.
// The sweep reaps what is provably done and keeps everything else: a
// dirty tree, a live claimant, an open PR, or an unverifiable bead all
// read as "unmerged work" — litter a human must triage by hand.

export interface LitterReap {
  /** worktrees removed — '<path> [<branch>]' ('would' list under dryRun) */
  reaped: string[]
  /** branches deleted ('would' list under dryRun) */
  branches: string[]
  /** bead claims released — '<id> (<why>)' ('would' list under dryRun) */
  released: string[]
  /** ghost dirs re-registered as worktrees ('would' list under dryRun) */
  repaired: string[]
  /** candidates kept — '<path|branch> (<why>)' */
  kept: string[]
  errors: string[]
}

export interface LitterReapOpts {
  /** repo anchor — any worktree of the repo works; every git op pins -C */
  root: string
  /** the verdict store — loopSlug(id) maps a litter branch onto a row */
  tasks: TaskStore
  /** review-host evidence — an open PR vetoes, a merged head pins the
   *  branch delete (squash merges make git's own --merged blind).
   *  Undefined skips the pass: closed-bead + clean still reaps and
   *  branches fall back to `branch -d`. */
  rev?: { repo: string; facade: ReviewFacade }
  /** the stack namespace counted as litter — 'stack/' sweeps every
   *  stack's members, 'stack/<name>/' scopes to one run's chain;
   *  undefined = loop/* only */
  stackPrefix?: string
  /** parked resume-cache cap — newest N clean open-bead trees survive,
   *  extras reap; 0/undefined = uncapped (spec bro-ho09d) */
  parkedKeep?: number
  /** parked trees idle past this many days reap regardless of the cap;
   *  0/undefined = no age bound */
  parkedTtlDays?: number
  dryRun?: boolean
  now?: number
}

/** Litter branch → bead slug: 'loop/<slug>' verbatim; stack members carry
 *  '<n>-<slug>' — parseStackBranch validates the shape. */
function litterSlug(branch: string, stackPrefix?: string): string | undefined {
  if (branch.startsWith('loop/')) {
    return branch.slice('loop/'.length)
  }
  if (stackPrefix !== undefined && branch.startsWith(stackPrefix)) {
    return parseStackBranch(branch)?.slug
  }
  return undefined
}

interface LitterCandidate {
  /** the live linked worktree the litter branch is checked out in —
   *  undefined for a bare branch */
  w?: WorktreeInfo
  branch: string
  slug: string
}

/** Everything one candidate's verdict and reap need that is not the
 *  candidate itself — shared state read once for the whole sweep. */
interface LitterCtx {
  opts: LitterReapOpts
  rep: LitterReap
  main: WorktreeInfo
  bySlug: Map<string, TaskRow>
  /** claim-liveness planes — who owns an in_progress bead's claim
   *  (spec bro-ho09d). Snapshotted once; the release re-reads the
   *  registry inside the lock so a respawn landing during the wait
   *  still wins. */
  claims: {
    /** loop run records — state already liveness-judged by
     *  collectLoopRuns (pid + pidStart) */
    runs: LoopRunView[]
    /** agents.json snapshot — undefined when unreadable, which fails
     *  CLOSED: an unknowable ownership plane answers "live" */
    registry: Record<string, AgentRegistryEntry> | undefined
    /** `<common>/bro/agents` — .exit death-proof files live here */
    agentsHome: string | null
    /** live .work/.task marker details — a session claiming the bead */
    sessionDetails: string[]
    /** live act-wait markers — a gate-stack member's claim survives its
     *  worker's exit: the loop (or a rearmed wait) still services it.
     *  `bead`/`workdir` are the match keys (bro-ho09d) */
    watches: ListedWatch[]
  }
}

interface PrEvidence {
  /** false when the host lookup threw — the candidate stays, the PR
   *  state is unknowable */
  known: boolean
  open: boolean
  /** a merged PR's head — the land proof AND the pin the branch delete
   *  compares against */
  mergedSha?: string
}

/** Admin debris + the worktree scan → worktree'd candidates. A failed
 *  list kills the sweep (the candidate set would be fiction); a failed
 *  prune only reports — the sweep still applies. Ghost dirs — siblings
 *  with no registration at all — are recovered BEFORE the candidate
 *  list so they re-enter through the normal verdicts. */
function litterCandidates(
  opts: LitterReapOpts,
  rep: LitterReap
): { main: WorktreeInfo; cands: LitterCandidate[] } | undefined {
  const pr = gitTry(['-C', opts.root, 'worktree', 'prune'])
  if (pr.code !== 0) {
    rep.errors.push(`worktree prune failed — ${pr.err || 'git error'}`)
  }
  const first = gitTry(['-C', opts.root, 'worktree', 'list', '--porcelain'])
  if (first.code !== 0) {
    rep.errors.push(`worktree list failed — ${first.err || 'git error'}`)
    return undefined
  }
  const main = parseWorktreePorcelain(first.out)[0]
  if (main === undefined) {
    rep.errors.push('worktree list returned no main entry')
    return undefined
  }
  recoverGhosts(opts, main, rep)
  // a recovered ghost is only visible to a fresh listing — re-read
  const wt = gitTry(['-C', opts.root, 'worktree', 'list', '--porcelain'])
  if (wt.code !== 0) {
    rep.errors.push(`worktree list failed — ${wt.err || 'git error'}`)
    return undefined
  }
  const all = parseWorktreePorcelain(wt.out)
  const cands: LitterCandidate[] = []
  const onTree = new Set<string>()
  for (const w of all.slice(1)) {
    if (w.branch === undefined || w.prunable !== undefined || !existsSync(w.path)) {
      continue
    }
    const slug = litterSlug(w.branch, opts.stackPrefix)
    if (slug === undefined) {
      continue
    }
    onTree.add(w.branch)
    cands.push({ w, branch: w.branch, slug })
  }
  litterBranches(opts, rep, onTree, cands)
  return { main, cands }
}

/** Ghost sibling dirs — `<main>--*` on disk but absent from `worktree
 *  list`, invisible to git's own prune (bro-ho09d). The sweep never
 *  guesses deletion: a `.git` file pointing into THIS repo's
 *  `worktrees/<name>` admin space is proof of origin — the admin dir is
 *  recreated (gitdir/commondir/HEAD bound to the branch the name
 *  implies) so the dir re-enters the sweep as a normal candidate.
 *  Everything else is kept and reported: a `.git` directory is a
 *  foreign clone, a pointer outside our admin space is foreign, a
 *  missing `.git` is only removal-safe when the dir is empty, and a
 *  ghost with no matching branch is human triage. */
function recoverGhosts(opts: LitterReapOpts, main: WorktreeInfo, rep: LitterReap): void {
  const reg = agentRegistryPath(opts.root)
  const common = reg === null ? null : dirname(dirname(reg))
  if (common === null) {
    return
  }
  const adminBase = join(common, 'worktrees')
  const parent = dirname(main.path)
  const prefix = `${basename(main.path)}--`
  const listed = new Set(
    parseWorktreePorcelain(
      gitTry(['-C', opts.root, 'worktree', 'list', '--porcelain']).out
    ).map((w) => resolve(w.path))
  )
  let sibs: string[]
  try {
    sibs = readdirSync(parent)
  } catch {
    return
  }
  for (const name of sibs) {
    if (!name.startsWith(prefix)) {
      continue
    }
    const path = join(parent, name)
    if (listed.has(resolve(path))) {
      continue
    }
    try {
      if (!statSync(path).isDirectory()) {
        continue
      }
    } catch {
      continue
    }
    recoverGhost(opts, path, name.slice(prefix.length), adminBase, rep)
  }
}

function recoverGhost(
  opts: LitterReapOpts,
  path: string,
  slug: string,
  adminBase: string,
  rep: LitterReap
): void {
  const keep = (why: string): void => {
    rep.kept.push(`${path} (ghost — ${why})`)
  }
  const dotgit = join(path, '.git')
  let isDir: boolean | undefined
  try {
    isDir = statSync(dotgit).isDirectory()
  } catch {
    // no .git at all — the only provably-safe removal is an empty dir
    let empty = false
    try {
      empty = readdirSync(path).length === 0
    } catch {
      // unreadable — keep below
    }
    if (empty) {
      if (opts.dryRun !== true) {
        rmSync(path, { recursive: true })
      }
      rep.reaped.push(`${path} (empty ghost dir)`)
      return
    }
    keep('no .git — not provably a worktree')
    return
  }
  if (isDir) {
    keep('separate clone')
    return
  }
  const admin = worktreeGitDir(path)
  if (admin === null || dirname(admin) !== adminBase) {
    keep('foreign .git pointer')
    return
  }
  if (existsSync(admin)) {
    return // registered but unlisted — worktree prune/list's business
  }
  const branch = ghostBranch(opts.root, slug)
  if (branch === undefined) {
    keep('no branch to bind')
    return
  }
  if (opts.dryRun === true) {
    rep.repaired.push(`${path} [${branch}]`)
    return
  }
  // rebuild the admin entry the way `worktree add` would have written
  // it — gitdir ↔ the worktree's own .git pointer, commondir back to
  // the shared dir, HEAD pinned to the branch. `read-tree HEAD` then
  // repopulates the index so status reads honestly (a ghost whose tip
  // moved off its checkout reads dirty — kept, not silently reaped).
  try {
    mkdirSync(admin, { recursive: true })
    writeFileSync(join(admin, 'gitdir'), `${dotgit}\n`)
    writeFileSync(join(admin, 'commondir'), '../..\n')
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`)
  } catch (err) {
    keep(`admin recreate failed — ${err instanceof Error ? err.message : err}`)
    return
  }
  gitTry(['-C', path, 'read-tree', 'HEAD'])
  rep.repaired.push(`${path} [${branch}]`)
}

/** The branch a recovered ghost binds HEAD to — the naming convention's
 *  own mapping: loop/<slug> first, work/<slug> (a `bro work enter`
 *  tail), else the stack member carrying <slug>. */
function ghostBranch(root: string, slug: string): string | undefined {
  const has = (b: string): boolean =>
    gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).code === 0
  for (const b of [`loop/${slug}`, `work/${slug}`]) {
    if (has(b)) {
      return b
    }
  }
  const st = gitTry(['-C', root, 'branch', '--list', 'stack/*', '--format=%(refname:short)'])
  if (st.code === 0) {
    for (const b of st.out.split('\n').filter((s) => s !== '')) {
      if (parseStackBranch(b)?.slug === slug) {
        return b
      }
    }
  }
  return undefined
}

/** Bare litter branches — a worktree-less loop/* is the same tail class. */
function litterBranches(
  opts: LitterReapOpts,
  rep: LitterReap,
  onTree: Set<string>,
  cands: LitterCandidate[]
): void {
  for (const pat of ['loop/', opts.stackPrefix]) {
    if (pat === undefined) {
      continue
    }
    const bl = gitTry(['-C', opts.root, 'branch', '--list', `${pat}*`, '--format=%(refname:short)'])
    if (bl.code !== 0) {
      rep.errors.push(`branch list ${pat}* failed — ${bl.err || 'git error'}`)
      continue
    }
    for (const b of bl.out.split('\n').filter((s) => s !== '' && !onTree.has(s))) {
      const slug = litterSlug(b, opts.stackPrefix)
      if (slug !== undefined) {
        cands.push({ branch: b, slug })
      }
    }
  }
}

/** slug → bead row over the whole store, closed rows included — the
 *  verdict record. An unreachable store leaves nothing provably done. */
function litterBeads(opts: LitterReapOpts, rep: LitterReap): Map<string, TaskRow> | undefined {
  try {
    return new Map(opts.tasks.list({ all: true }).map((r) => [loopSlug(r.id), r]))
  } catch (err) {
    rep.errors.push(`bead list failed — ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** Live registry occupants pinning a tree — an agent (a respawned drive
 *  fixer, say) working a closed bead's tree still owns it. Undefined
 *  when the registry is unreadable: readAgentRegistry deliberately
 *  re-throws on corruption (a silent {} lets a reaper orphan live
 *  agents' trees — bro-f6zp), so an unknowable occupancy plane is a
 *  keep verdict, not an empty map. */
function litterOccupants(root: string): Map<string, string> | undefined {
  const occupied = new Map<string, string>()
  try {
    for (const [molStep, e] of Object.entries(readAgentRegistry(root))) {
      const path = typeof e.worktree === 'string' ? resolve(e.worktree) : undefined
      const live =
        typeof e.pid === 'number' &&
        pidAlive(e.pid, typeof e.pidStart === 'string' ? e.pidStart : undefined)
      if (path !== undefined && live) {
        occupied.set(path, e.agentId || molStep)
      }
    }
    return occupied
  } catch {
    return undefined
  }
}

/** An open PR vetoes outright; a merged one is the land proof AND the
 *  head pin the branch delete compares against. */
function litterPrEvidence(opts: LitterReapOpts, branch: string): PrEvidence {
  const ev: PrEvidence = { known: true, open: false }
  if (opts.rev === undefined) {
    return ev
  }
  try {
    for (const pr of opts.rev.facade.prsForBranch(branch, 'all')) {
      const meta = opts.rev.facade.prMeta({ repo: opts.rev.repo, pr })
      if (meta.state === 'OPEN') {
        ev.open = true
      } else if (meta.state === 'MERGED' && ev.mergedSha === undefined) {
        ev.mergedSha = meta.headSha
      }
    }
  } catch {
    ev.known = false
  }
  return ev
}

/** Worktree-side keep reasons, called under the occupancy lock — the
 *  check and the removal must be one section or a claimant pinning the
 *  path after the check loses its live tree (bro-qry9, bro-0fiq). Only
 *  read after the candidate proved done and veto-free; undefined means
 *  the tree is safe to reap. */
function litterTreeVerdict(c: LitterCandidate, ctx: LitterCtx): string | undefined {
  const w = c.w
  if (w === undefined) {
    return undefined
  }
  if (w.locked !== undefined) {
    return w.locked === '' ? 'locked' : `locked (${w.locked})`
  }
  const occupied = litterOccupants(ctx.opts.root)
  if (occupied === undefined) {
    return 'agent registry unreadable'
  }
  const occupant = occupied.get(resolve(w.path))
  if (occupant !== undefined) {
    return `agent ${occupant} live`
  }
  if (worktreeClaim(w.path, ctx.opts.now) !== undefined) {
    return 'claimed'
  }
  // the same cleanliness bar removeMergedWorktree enforces, read ahead
  // so kept candidates report a reason
  const st = gitTry(['-c', 'status.showUntrackedFiles=all', '-C', w.path, 'status', '--porcelain'])
  if (st.code !== 0) {
    return 'cleanliness unverifiable'
  }
  return st.out.trim() === '' ? undefined : 'dirty'
}

/** The evidence-plane keep reason — bead verdict + PR state. undefined
 *  means provably done (the bead closed — the loop's land/verdict
 *  record — or a merged PR names the branch; either proves the work
 *  left) and veto-free; the tree plane is judged separately, under the
 *  occupancy lock. */
function litterDoneVerdict(c: LitterCandidate, ctx: LitterCtx, pr: PrEvidence): string | undefined {
  const bead = ctx.bySlug.get(c.slug)
  if (bead?.status !== 'closed' && pr.mergedSha === undefined) {
    return bead === undefined ? 'no bead — unverifiable' : `bead ${bead.status ?? 'open'}`
  }
  if (!pr.known) {
    return 'PR lookup failed'
  }
  if (pr.open) {
    return 'open PR — unmerged'
  }
  return undefined
}

/** Branch-side retire — a removed/absent worktree frees the branch, so
 *  reaching this code means it is never checked out. A merged PR's head
 *  pins the delete (a squash merge makes git's own --merged blind; only
 *  the host knows the landing). A closed-bead verdict with no merged PR
 *  in reach falls back to git's own merged check: `branch -d` refuses a
 *  tip holding commits past the checked-out base — unlanded work keeps
 *  its branch, whatever the bead says. */
function retireLitterBranch(c: LitterCandidate, ctx: LitterCtx, pr: PrEvidence): void {
  const { opts, rep } = ctx
  if (opts.dryRun === true) {
    rep.branches.push(c.branch)
    return
  }
  if (pr.mergedSha === undefined) {
    const del = gitTry(['-C', opts.root, 'branch', '-d', c.branch])
    if (del.code === 0) {
      rep.branches.push(c.branch)
    } else {
      rep.kept.push(
        `${c.branch} (${/not fully merged/i.test(del.err) ? 'unlanded commits' : 'branch delete refused'})`
      )
    }
    return
  }
  deleteMergedLocalBranch(c.branch, pr.mergedSha)
  if (gitTry(['-C', opts.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`]).code !== 0) {
    rep.branches.push(c.branch)
  } else {
    rep.kept.push(`${c.branch} (branch delete refused)`)
  }
}

// --- claim liveness + release (spec bro-ho09d) ----------------------------------
//
// A claim is only as real as its worker: `in_progress` with every
// ownership plane dead is an orphan — release the claim so the bead
// re-queues, then the tree flows through the same verdicts as any
// open-bead litter. Every plane fails CLOSED (unverifiable = live):
// releasing a live worker's claim is the worst outcome this code can
// produce.

/** The claim's live owner, or undefined when every plane is dead. */
function claimOwner(ctx: LitterCtx, c: LitterCandidate, bead: TaskRow): string | undefined {
  const { claims } = ctx
  // loop run records — collectLoopRuns already judged pid+pidStart;
  // beadIds covers the whole claimed clump, not just the lead
  for (const v of claims.runs) {
    if (
      v.state === 'running' &&
      (v.beadId === bead.id || v.beadIds?.includes(bead.id) === true || v.slug === c.slug)
    ) {
      return `loop worker pid ${v.pid} live`
    }
  }
  // agent registry — an unreadable plane is not a dead worker
  if (claims.registry === undefined) {
    return 'agent registry unreadable'
  }
  for (const [molStep, e] of Object.entries(claims.registry)) {
    const hitsBead = molStep === bead.id
    const hitsTree =
      c.w !== undefined &&
      typeof e.worktree === 'string' &&
      resolve(e.worktree) === resolve(c.w.path)
    if ((hitsBead || hitsTree) && registryEntryHoldsClaim(claims.agentsHome, e)) {
      return `agent ${e.agentId || molStep} live`
    }
  }
  // session markers — `bd --claim` arms .task, `bro work enter` arms .work
  const detail = claims.sessionDetails.find((d) =>
    detailMatches(d, { branch: c.branch, slug: c.slug, worktree: c.w?.path })
  )
  if (detail !== undefined) {
    return `session armed ${detail}`
  }
  // live watch markers — a landed member's claim rides its act wait
  // (bro-q6ppv): the loop services the gate stack past the worker's exit
  for (const l of claims.watches) {
    if (!l.alive) {
      continue
    }
    // a clump's whole id list rides the marker comma-joined (bro-q6ppv)
    const hitsBead = l.watch.bead?.split(',').includes(bead.id) === true
    const hitsTree =
      c.w !== undefined &&
      typeof l.watch.workdir === 'string' &&
      resolve(l.watch.workdir) === resolve(c.w.path)
    if (hitsBead || hitsTree) {
      return `watch on PR #${l.watch.pr} live`
    }
  }
  // a live agent-shaped process inside the tree — covers a worker that
  // never registered (spawn crashed after fork, record write lost)
  if (c.w !== undefined) {
    const hit = agentProcessesIn(c.w.path)[0]
    if (hit !== undefined) {
      return `process ${hit.pid} live in tree`
    }
  }
  return undefined
}

/** Release an orphaned claim — every plane dead. Runs the final
 *  liveness re-check and the note+reopen inside the shared registry
 *  lock: a respawn's claim→register writes under the same lock, so a
 *  worker landing during our wait either shows up in the re-read or
 *  claims after we've released (the reopened bead is then its target —
 *  correct). Returns the keep reason when the claim survives,
 *  undefined when it was released (or would be, under dry-run). */
function releaseDeadClaim(
  ctx: LitterCtx,
  c: LitterCandidate,
  bead: TaskRow
): string | undefined {
  const { opts, rep } = ctx
  const pre = claimOwner(ctx, c, bead)
  if (pre !== undefined) {
    return pre
  }
  let release: () => void
  try {
    release = acquireAgentRegistryLock(ctx.main.path)
  } catch {
    return 'occupancy lock contended'
  }
  try {
    // re-read under the lock — the snapshot predates the wait, and a
    // respawn's registry write lands inside this same section
    let registry: Record<string, AgentRegistryEntry> | undefined
    try {
      registry = readAgentRegistry(opts.root)
    } catch {
      registry = undefined
    }
    const owner = claimOwner(
      { ...ctx, claims: { ...ctx.claims, registry } },
      c,
      bead
    )
    if (owner !== undefined) {
      return owner
    }
    if (opts.dryRun !== true) {
      try {
        opts.tasks.note(
          bead.id,
          'bro work prune --loop: released orphaned claim — every worker-liveness plane is dead (bro-ho09d)'
        )
        opts.tasks.reopen(bead.id)
      } catch (err) {
        rep.errors.push(
          `claim release for ${bead.id} failed — ${err instanceof Error ? err.message : err}`
        )
        return 'claim release failed'
      }
    }
    // the snapshot row drives the rest of the sweep's verdicts
    bead.status = 'open'
    rep.released.push(`${bead.id} (no live worker)`)
    return undefined
  } finally {
    release()
  }
}

/** Milliseconds since the worktree's last visible activity — the dir
 *  entry itself (checkout/bootstrap churn) or its gitdir's
 *  index/HEAD-reflog (commits, checkouts). A dead tree's clock froze
 *  with it; unreadable stat fields just don't move the max. */
export function worktreeIdleMs(path: string, now: number = Date.now()): number {
  let t = 0
  try {
    t = statSync(path).mtimeMs
  } catch {
    // gone mid-sweep — the verdict pass reports it separately
  }
  const gd = worktreeGitDir(path)
  if (gd !== null) {
    for (const f of ['index', 'logs/HEAD', 'HEAD', '.']) {
      try {
        t = Math.max(t, statSync(join(gd, f)).mtimeMs)
      } catch {
        // partial admin — skip
      }
    }
  }
  return t === 0 ? Number.POSITIVE_INFINITY : now - t
}

/** One candidate: claim liveness first (an in_progress bead with a dead
 *  worker is an orphan — released, then judged as open-bead litter),
 *  then the evidence verdict, then — for a worktree'd branch — the
 *  tree guards and the removal as ONE locked section. The shared
 *  registry lock is the same one claimWorktree and finishWorktreeEnter
 *  hold across their claim→stamp / check→remove spans: without it a
 *  claimant or respawned fixer can pin the path after the check and
 *  lose its live tree to the removal (bro-qry9, bro-0fiq). A lock
 *  contended past the bound is itself a claimant mid-act → keep. A
 *  failed removal keeps the branch too — it is still checked out there. */
function reapCandidate(c: LitterCandidate, ctx: LitterCtx, parked: ParkedCand[]): void {
  const { opts, rep, main } = ctx
  const pr = litterPrEvidence(opts, c.branch)
  const label = c.w?.path ?? c.branch
  const bead = ctx.bySlug.get(c.slug)
  if (bead?.status === 'in_progress') {
    const owner = releaseDeadClaim(ctx, c, bead)
    if (owner !== undefined) {
      rep.kept.push(`${label} (bead in_progress — ${owner})`)
      return
    }
    // released — the bead reads open for the verdicts below
  }
  const done = litterDoneVerdict(c, ctx, pr)
  if (done !== undefined) {
    // open/non-terminal beads keep their tree only as resume cache —
    // they pool; every other keep reason is unconditional. A PR veto
    // (open or unreadable) never pools — the work is visibly in flight
    if (c.w !== undefined && bead !== undefined && bead.status !== 'closed' && pr.known && !pr.open) {
      parked.push({ c, pr, done })
      return
    }
    rep.kept.push(`${label} (${done})`)
    return
  }
  if (c.w === undefined) {
    retireLitterBranch(c, ctx, pr)
    return
  }
  let release: () => void
  try {
    release = acquireAgentRegistryLock(main.path)
  } catch {
    rep.kept.push(`${label} (occupancy lock contended)`)
    return
  }
  try {
    const why = litterTreeVerdict(c, ctx)
    if (why !== undefined) {
      rep.kept.push(`${label} (${why})`)
      return
    }
    if (opts.dryRun !== true && !removeMergedWorktree(c.w.path, c.w, main)) {
      rep.errors.push(`worktree ${c.w.path} not removed`)
      return
    }
    rep.reaped.push(`${c.w.path} [${c.branch}]`)
  } finally {
    release()
  }
  retireLitterBranch(c, ctx, pr)
}

interface ParkedCand {
  c: LitterCandidate
  pr: PrEvidence
  /** the keep reason the candidate earned — reported for survivors */
  done: string
}

/** The parked pool pass — open-bead trees kept only as a resume cache,
 *  bounded by `parkedKeep`/`parkedTtlDays` (spec bro-ho09d). Newest
 *  first; a dirty/locked/claimed/occupied tree keeps outright and never
 *  consumes a pool slot — it is data, not cache. Evictions keep the
 *  branch (cheap) via the same retire rule done litter uses. */
function reapParkedPool(parked: ParkedCand[], ctx: LitterCtx): void {
  const { opts, rep, main } = ctx
  if (parked.length === 0) {
    return
  }
  const now = opts.now ?? Date.now()
  const keepN = opts.parkedKeep ?? 0
  const ttlMs = (opts.parkedTtlDays ?? 0) * 24 * 60 * 60 * 1000
  const scored = parked
    .map((p) => ({ ...p, idle: worktreeIdleMs(p.c.w!.path, now) }))
    .sort((a, b) => a.idle - b.idle)
  let kept = 0
  for (const { c, pr, done, idle } of scored) {
    const label = c.w!.path
    let release: () => void
    try {
      release = acquireAgentRegistryLock(main.path)
    } catch {
      rep.kept.push(`${label} (occupancy lock contended)`)
      continue
    }
    try {
      const why = litterTreeVerdict(c, ctx)
      if (why !== undefined) {
        rep.kept.push(`${label} (${why})`)
        continue
      }
      const overCap = keepN > 0 && kept >= keepN
      const stale = ttlMs > 0 && idle > ttlMs
      if (!overCap && !stale) {
        kept += 1
        rep.kept.push(`${label} (${done})`)
        continue
      }
      if (opts.dryRun !== true && !removeMergedWorktree(c.w!.path, c.w!, main)) {
        rep.errors.push(`worktree ${c.w!.path} not removed`)
        continue
      }
      rep.reaped.push(
        `${c.w!.path} [${c.branch}] — parked pool ${stale ? 'idle past TTL' : `over cap ${keepN}`}`
      )
    } finally {
      release()
    }
    retireLitterBranch(c, ctx, pr)
  }
}

export function reapLoopLitter(opts: LitterReapOpts): LitterReap {
  const rep: LitterReap = { reaped: [], branches: [], released: [], repaired: [], kept: [], errors: [] }
  const found = litterCandidates(opts, rep)
  if (found === undefined) {
    return rep
  }
  const bySlug = litterBeads(opts, rep)
  if (bySlug === undefined) {
    return rep
  }
  // claim-liveness planes — snapshotted once for the sweep; the release
  // re-reads the registry inside the lock before writing
  const regPath = agentRegistryPath(opts.root)
  const hooks = hooksDirOf(opts.root)
  let registry: Record<string, AgentRegistryEntry> | undefined
  try {
    registry = readAgentRegistry(opts.root)
  } catch {
    registry = undefined
  }
  const ctx: LitterCtx = {
    opts,
    rep,
    main: found.main,
    bySlug,
    claims: {
      runs: collectLoopRuns(opts.root, opts.now ?? Date.now()),
      registry,
      agentsHome: regPath === null ? null : join(dirname(regPath), 'agents'),
      sessionDetails:
        hooks === null ? [] : liveWorkDetails(hooks, ['.work', '.task'], opts.now ?? Date.now()),
      watches: listWatches(opts.root),
    },
  }
  const parked: ParkedCand[] = []
  for (const c of found.cands) {
    reapCandidate(c, ctx, parked)
  }
  reapParkedPool(parked, ctx)
  // dead run records whose beads still read in_progress — litter may
  // have been hand-cleaned already; the claim is still orphaned. A
  // record's beadIds covers every clump member, not only the lead.
  const handled = new Set(found.cands.map((c) => ctx.bySlug.get(c.slug)?.id).filter(Boolean))
  for (const v of ctx.claims.runs) {
    if (v.state !== 'dead') {
      continue
    }
    const ids = [...new Set([v.beadId, ...(v.beadIds ?? [])])]
    for (const id of ids) {
      const bead = ctx.bySlug.get(loopSlug(id)) ?? ctx.bySlug.get(v.slug)
      if (bead === undefined || bead.status !== 'in_progress' || handled.has(bead.id)) {
        continue
      }
      releaseDeadClaim(ctx, { branch: '', slug: loopSlug(bead.id) }, bead)
    }
  }
  return rep
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
      return cmdPrune(rest)
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
