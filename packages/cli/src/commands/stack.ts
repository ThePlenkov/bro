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
 *                       (first member bases on the default branch)
 *   bro stack list [<name>]   the chain: position, bead, branch, base,
 *                             worktree state, PR
 *   bro stack sync [<name>]   after a member merges: retarget open child
 *                             PRs and rebase child branches onto the new
 *                             base; dirty or locked worktrees are skipped
 *                             and reported — the owner rebases on enter
 *   bro stack publish [<name>]
 *                       register the chain's open member PRs as the
 *                       host's server-side stack (GitHub's Stack object
 *                       via `gh stack link`); hosts that detect chains
 *                       themselves (GitLab, plain git) decline the call
 */
import { basename } from 'node:path'
import {
  acquireFileLock,
  facade,
  gitTry,
  LockTimeout,
  MANUAL_CASCADE,
  mergeChainPerLayer,
  reviewHost,
  shQuote,
  stackHost,
  type PrMeta,
  type ReviewFacade,
  type StackCascade,
  type StackChainMember,
  type StackFacade,
  type StackMergeOpts,
} from '@broject/core'
import {
  acquireMergeSlot,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  releaseMergeSlot,
} from '@broject/act'
import {
  displayBase,
  formatStackBranch,
  isStackName,
  nextIndex,
  parseStackBranch,
  planSync,
  stackMembers,
  stackNames,
  stackTop,
  type SyncMemberInput,
  type SyncPlanItem,
} from '@broject/stack'
import { flag, positionals } from './args.ts'
import { loadBroConfig } from '../plugins.ts'
import {
  createWorktree,
  dirtyCount,
  finishWorktreeEnter,
  mainWorktree,
  defaultBranchName,
  parseWorktreePorcelain,
  readStackEdges,
  recordStackEdge,
  removeStackEdge,
  stackPushLockPath,
  stateOfWorktree,
  type EnterWorktreeResult,
  type WorktreeCreateResult,
  type WorktreeInfo,
} from './work.ts'

const NAME_FLAGS = new Set(['--name'])

function usage(): never {
  console.error(`usage:
  bro stack push <bead> [--name <stack>]
  bro stack list [<name>]
  bro stack sync [<name>]
  bro stack publish [<name>]
  bro stack merge [<name>] [--squash|--merge|--rebase] [--admin]`)
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

/** The live member carrying this bead's slug — a re-push re-enters that
 *  member instead of minting a second position for the same bead. */
export function stackMemberFor(dir: string, name: string, slug: string) {
  return stackMembers(allBranches(dir), name).find((m) => m.slug === slug)
}

/** One PR per stack member, newest first: OPEN wins, else the most
 *  recent MERGED/CLOSED. `prsForBranch(branch, 'all')` lists every
 *  state — without it a merged member is invisible to sync. */
function memberPr(
  rev: { repo: string; facade: ReviewFacade },
  branch: string
): { pr: number; meta: PrMeta } | undefined {
  const prs = rev.facade.prsForBranch(branch, 'all')
  let merged: { pr: number; meta: PrMeta } | undefined
  for (const pr of prs.slice(0, 5)) {
    const meta = rev.facade.prMeta({ repo: rev.repo, pr })
    if (meta.state === 'OPEN') {
      return { pr, meta }
    }
    merged ??= { pr, meta }
  }
  return merged
}

/** Branches of members whose PR reports MERGED — dead ends for tip
 *  selection even while the branch still exists. `undefined` when the
 *  host can't answer (offline → conservative: nothing reads as merged). */
export function mergedBranches(
  dir: string,
  name: string,
  rev: { repo: string; facade: ReviewFacade } | undefined
): ReadonlySet<string> | undefined {
  if (rev === undefined) {
    return undefined
  }
  const dead = new Set<string>()
  for (const m of stackMembers(allBranches(dir), name)) {
    try {
      if (memberPr(rev, m.branch)?.meta.state === 'MERGED') {
        dead.add(m.branch)
      }
    } catch {
      // host unreachable mid-lookup — the member stays live, the
      // conservative answer
    }
  }
  return dead
}

/** The stack tip for a push: the highest-n LIVE member branch. A merged
 *  member's branch is a dead end — its commits already reached the
 *  default branch — so `dead` members are skipped; the next member then
 *  bases on the nearest live member (or the default branch) and gets
 *  the next position number (merged slots are never reused). */
export function stackTip(
  dir: string,
  name: string,
  dead?: ReadonlySet<string>
): { n: number; base?: string } {
  const members = stackMembers(allBranches(dir), name)
  return { n: nextIndex(members), base: stackTop(members, dead)?.branch }
}

function cmdPush(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS)
  const slug = pos[0]
  // same contract parseStackBranch applies — a slug it rejects would
  // mint a member branch the stack view can never see
  if (!slug || !isStackName(slug)) {
    console.error('error: push needs a bead/slug (git-ref-safe: [a-z0-9_.-], no leading ./-)')
    usage()
  }
  const name = resolveStackName(argv)
  const main = mainWorktree()
  const defaultRef = defaultBranchName()
  // the push lock serializes member-listing → worktree-add across bro
  // processes: without it two concurrent pushes (loop workers, push +
  // loop racing) read the same tip and both mint position n under
  // different slugs. The section ends at `worktree add` — once the
  // branch exists a waiter's recompute sees it; the slower post-add
  // steps (submodule init, bead claim) stay outside the hold.
  const lockPath = stackPushLockPath(name)
  if (lockPath === null) {
    console.error('note: could not resolve the git common dir — pushing without the stack lock')
  }
  let release: (() => void) | undefined
  try {
    release =
      lockPath === null ? undefined : acquireFileLock(lockPath, { label: `stack ${name} push lock` })
  } catch (err) {
    if (err instanceof LockTimeout) {
      console.error(`error: ${err.message} — another push is in flight; retry`)
    } else {
      console.error(`error: ${(err as Error).message}`)
    }
    process.exit(1)
  }
  let n: number
  let created: WorktreeCreateResult
  let base: string | undefined
  let reenter = false
  try {
    // re-pushing a bead that already sits in the stack re-enters its member
    // branch — push is idempotent, never a duplicate position
    const existing = stackMemberFor(main.path, name, slug)
    reenter = existing !== undefined
    const rev = resolveReview(main.path)
    const dead = existing === undefined ? mergedBranches(main.path, name, rev) : undefined
    const tip = existing === undefined ? stackTip(main.path, name, dead) : undefined
    n = existing?.n ?? tip!.n
    const branch = existing?.branch ?? formatStackBranch(name, n, slug)
    base =
      (existing === undefined ? undefined : readStackEdges().get(existing.branch)) ??
      tip?.base ??
      defaultRef ??
      main.branch ??
      main.head
    created = createWorktree({
      slug,
      branch,
      base: existing === undefined ? base : undefined,
      main,
      defaultRef,
      allowExisting: existing !== undefined,
      reusePath: existing !== undefined,
    })
  } finally {
    release?.()
  }
  const r = finishWorktreeEnter(
    {
      slug,
      branch: created.branch,
      base: reenter ? undefined : base,
      main,
      defaultRef,
    },
    created
  )
  reportPush(r, name, n, base, slug, resolveStacks(main.path))
}

/** Push result reporting — a `gone` worktree was retired by a driver
 *  before the claim landed, so the push aborts instead of printing a
 *  dead path as ready. */
function reportPush(
  r: EnterWorktreeResult,
  name: string,
  n: number,
  base: string | undefined,
  slug: string,
  stacks: StackFacade | undefined
): void {
  if (r.claimLockTimedOut) {
    console.error(
      `error: claim lock for ${r.path} timed out — ` +
        (r.partialRemoved === true
          ? 'removed the partial worktree; retry push'
          : `worktree left at ${r.path} — inspect it before retrying`)
    )
    process.exit(1)
  }
  if (r.gone) {
    console.error(`error: ${r.path} was retired before the claim could land — aborting`)
    process.exit(1)
  }
  console.log(`worktree ready: ${r.path}  (branch ${r.branch})`)
  console.log(`stack ${name} member ${n} — based on ${r.base ?? base ?? 'HEAD'}`)
  if (r.stacked) {
    // the hint is the connector's — `gh pr create`, `glab mr create`, or
    // nothing on a forge-less host. An unresolved facade keeps the gh
    // text: still the most likely intent in that failure mode.
    const hint =
      stacks?.openHint?.({ branch: r.branch, base: r.base ?? '' }) ??
      (stacks === undefined && r.base !== undefined
        ? `gh pr create --base ${shQuote(r.base)}`
        : undefined)
    if (hint !== undefined) {
      console.log(`open the PR against the parent member: ${hint}`)
    }
  }
  if (r.claim.claimed) {
    console.log(`claimed bead ${r.claim.claimed} for this session`)
  } else if (r.claim.refused) {
    console.error(`note: could not claim bead ${slug} — another actor may hold it`)
  }
}

interface MemberView extends SyncMemberInput {
  pr?: number
  headSha?: string
  worktree?: WorktreeInfo
}

/** Why a member can't be rewritten locally — the skip report's reason. */
function blockedReason(w: WorktreeInfo | undefined, dirty: number): string | undefined {
  if (w === undefined) {
    return 'no worktree'
  }
  if (w.locked !== undefined) {
    return w.locked === '' ? 'locked' : `locked (${w.locked})`
  }
  if (dirty < 0) {
    return 'worktree gone'
  }
  return dirty === 0 ? undefined : `dirty worktree (${dirty} file(s))`
}

/** PR state onto a member — OPEN/MERGED base + state; a failing host is
 *  not fatal: the fields stay undefined and the member reads as
 *  unmerged, which is the conservative answer for sync. */
function attachPr(
  m: MemberView,
  rev: { repo: string; facade: ReviewFacade } | undefined
): void {
  if (rev === undefined) {
    return
  }
  try {
    const hit = memberPr(rev, m.branch)
    if (hit !== undefined) {
      m.pr = hit.pr
      m.prState = hit.meta.state
      m.prBase = hit.meta.baseRef
      m.headSha = hit.meta.headSha
    }
  } catch {
    // host unreachable — member reads as unmerged/untargeted
  }
}

/** Live member state: branch namespace + edges + worktrees + PRs. */
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
    const dirty = !w?.path ? -1 : dirtyCount(w.path)
    const blocked = blockedReason(w, dirty)
    const m: MemberView = {
      ...b,
      edgeBase: edges.get(b.branch),
      worktree: w,
      rebaseable: blocked === undefined,
      blocked,
    }
    attachPr(m, rev)
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

/** The connector's stack semantics for this repo — undefined when no
 *  connector serves `stacks` (no remote match, nothing authed). The
 *  caller's answer to that is the universal one: manual retarget, local
 *  rebase, no forge ops. A pinned `connectors.reviews` is also the
 *  stacks default when it serves the facade: self-hosted forges (GHES,
 *  self-managed GitLab) never matchRemote, so the git dir-match would
 *  otherwise win and the repo would lose the forge's openHint and
 *  cascade semantics. An explicit `connectors.stacks` still wins. */
function resolveStacks(root: string): StackFacade | undefined {
  try {
    const connectors = loadBroConfig(root).connectors
    if (connectors.stacks === undefined && connectors.reviews !== undefined) {
      try {
        return facade('stacks', { dir: root }, { connector: connectors.reviews })
      } catch {
        // the pinned reviews connector doesn't serve stacks — resolve normally
      }
    }
    return stackHost(root, connectors)
  } catch {
    return undefined
  }
}

/** One member row in `stack list` — position, slug, branch, effective
 *  base, worktree state, PR state + target. */
function memberLine(
  m: MemberView,
  defaultBase: string,
  rev: { repo: string; facade: ReviewFacade } | undefined,
  root: string
): string {
  const stale =
    m.edgeBase !== undefined && m.edgeBase !== defaultBase && !localBranch(root, m.edgeBase)
  const wt =
    m.worktree === undefined
      ? 'no-worktree'
      : `${basename(m.worktree.path)} ${stateOfWorktree(m.worktree)}`
  let pr = 'PR?' // no review host resolved — can't tell
  if (rev !== undefined) {
    pr = m.pr === undefined ? 'no-PR' : `${rev.facade.prLink(rev.repo, m.pr)} ${m.prState}→${m.prBase}`
  }
  const base = displayBase(m, defaultBase)
  return `  ${m.n}  ${m.slug}  ${m.branch}  base ${base}${stale ? ' (stale edge)' : ''}  ${wt}  ${pr}`
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
  const stacks = resolveStacks(main.path)
  for (const name of names) {
    const members = collectMembers(name, main.path, rev)
    console.log(`stack ${name}  (${members.length} member${members.length === 1 ? '' : 's'})`)
    for (const m of members) {
      console.log(memberLine(m, defaultBase, rev, main.path))
    }
    // the publish hint needs both caps: membership detects the gap,
    // publish is the fix it names. Neither present → the host has no
    // stack registry and there is nothing to hint at.
    if (stacks?.publish !== undefined && stacks.membership !== undefined) {
      const open = members.filter((m) => m.pr !== undefined && m.prState === 'OPEN')
      const unstacked = open.filter((m) => stacks.membership!(m) === null)
      if (open.length >= 2 && unstacked.length > 0) {
        console.log(
          `  ${unstacked.length} of ${open.length} open member PRs not in a stack on the host — \`bro stack publish ${name}\``
        )
      }
    }
  }
}

/** A merged member leaves the chain — its edge goes, and its branch
 *  goes too when no worktree still holds it (a checked-out branch can't
 *  be deleted; the owner's worktree keeps it until `work leave`). */
function retireMerged(
  m: MemberView,
  root: string,
  lines: string[]
): void {
  removeStackEdge(m.branch)
  if (m.worktree !== undefined) {
    lines.push(`  ${m.branch} merged — leaves the chain (worktree keeps the branch)`)
    return
  }
  const del = gitTry(['-C', root, 'branch', '-D', m.branch])
  lines.push(
    del.code === 0
      ? `  ${m.branch} merged — edge + branch removed`
      : `  ${m.branch} merged — edge removed, branch kept (${del.err.trim() || 'delete failed'})`
  )
}

/** Rebase a member's branch onto its new base and force-push the result
 *  when a PR rides it. The fork point is the recorded old base — under
 *  squash merges a merge-base can predate the parent's commits and
 *  replay already-squashed changes; the edge is the truthful fork. */
function rebaseMember(item: SyncPlanItem<MemberView>, lines: string[]): boolean {
  const m = item.member
  const wt = m.worktree!
  const oldRef =
    item.oldBase !== item.desiredBase &&
    gitTry(['-C', wt.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${item.oldBase}`]).code === 0
      ? item.oldBase
      : undefined
  const fork = oldRef ?? gitTry(['-C', wt.path, 'merge-base', item.desiredBase, 'HEAD']).out.trim()
  const rb =
    fork === ''
      ? { code: 1, err: `no merge-base with ${item.desiredBase}` }
      : gitTry(['-C', wt.path, 'rebase', '--onto', item.desiredBase, fork])
  if (rb.code !== 0) {
    gitTry(['-C', wt.path, 'rebase', '--abort'])
    lines.push(`  ${m.branch} rebase onto ${item.desiredBase} failed — aborted; owner resolves on enter`)
    return false
  }
  lines.push(`  ${m.branch} rebased onto ${item.desiredBase}`)
  if (m.pr === undefined) {
    return true
  }
  // a rebased branch with an open PR must move the remote head too —
  // retargeting while the remote still carries pre-rebase commits
  // would inflate the PR diff
  const push = gitTry(['-C', wt.path, 'push', '--force-with-lease', 'origin', `HEAD:refs/heads/${m.branch}`])
  if (push.code !== 0) {
    lines.push(`  ${m.branch} push failed — ${push.err || 'remote refused'}; retarget skipped`)
    return false
  }
  return true
}

/** Move the member's recorded edge to its new base — the edge is the
 *  fork truth, so it updates even when the PR retarget is refused (a
 *  stale edge would re-schedule the rewrite on every later sync). */
function updateEdge(m: MemberView, desiredBase: string, defaultBase: string): void {
  if (desiredBase === defaultBase) {
    removeStackEdge(m.branch)
  } else {
    recordStackEdge(m.branch, desiredBase)
  }
}

/** Retarget the member's PR to its new base. False when the move was
 *  owed and didn't land — a refused retarget or a host without
 *  retargetPr leaves the chain's base==prev-head invariant broken, and
 *  the caller defers the publish tail rather than feeding it to the
 *  host's stack tool. */
function retargetMember(
  item: SyncPlanItem<MemberView>,
  rev: { repo: string; facade: ReviewFacade } | undefined,
  lines: string[]
): boolean {
  const m = item.member
  if (!item.retarget || m.pr === undefined) {
    return true
  }
  if (rev?.facade.retargetPr === undefined) {
    lines.push(`  ${m.branch} — review host cannot retarget PRs; set --base by hand`)
    return false
  }
  const ok = rev.facade.retargetPr({ repo: rev.repo, pr: m.pr }, item.desiredBase)
  lines.push(
    ok
      ? `  ${rev.facade.prLink(rev.repo, m.pr)} retargeted → ${item.desiredBase}`
      : `  ${rev.facade.prLink(rev.repo, m.pr)} retarget refused`
  )
  return ok
}

/** A merge the platform performed moved the remote branch and
 *  retargeted the PR, but this member's worktree still sits on the old
 *  commits — fetch and rebase onto FETCH_HEAD. The platform replayed
 *  the branch's own commits server-side, so patch-equivalence drops
 *  them from the replay and only work never pushed lands on top —
 *  never a reset that would silently discard it. A failed fetch means
 *  the remote branch is gone (or unreachable): keep the worktree.
 *  Returns false when the follow didn't complete — the caller leaves
 *  the edge stale so the next sync reschedules the work. */
function followRemote(m: MemberView, lines: string[]): boolean {
  const wt = m.worktree!
  const probe = gitTry(['-C', wt.path, 'fetch', 'origin', m.branch])
  if (probe.code !== 0) {
    lines.push(`  ${m.branch} remote gone — worktree left as-is`)
    return false
  }
  const before = gitTry(['-C', wt.path, 'rev-parse', 'HEAD']).out.trim()
  const rb = gitTry(['-C', wt.path, 'rebase', 'FETCH_HEAD'])
  if (rb.code !== 0) {
    gitTry(['-C', wt.path, 'rebase', '--abort'])
    lines.push(
      `  ${m.branch} rebase onto the rewritten remote failed — aborted; owner resolves on enter`
    )
    return false
  }
  const after = gitTry(['-C', wt.path, 'rev-parse', 'HEAD']).out.trim()
  lines.push(
    before === after
      ? `  ${m.branch} already on the rewritten remote`
      : `  ${m.branch} moved to origin/${m.branch} (platform rewrote the remote)`
  )
  return true
}

/** What publish settled into — 'skipped' is the benign quiet path
 *  (fewer than two open PRs, nothing attempted): the sync caller must
 *  not read it as a failure. Only 'failed' propagates — a split
 *  refusal, a thrown link, or an unproven membership readback. */
type PublishOutcome = 'registered' | 'skipped' | 'failed'

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
  const ids = new Set<number>()
  let unstacked = 0
  for (const m of open) {
    const hit = membership(m)
    if (hit === null) {
      unstacked++
    } else {
      ids.add(hit.id)
    }
  }
  if (ids.size > 1) {
    const list = [...ids].map((i) => `#${i}`).join(', ')
    lines.push(`  stack ${name}: members sit in different host stacks (${list}) — split by hand`)
    return 'refused'
  }
  if (ids.size === 1 && unstacked === 0) {
    if (!quiet) {
      lines.push(`  stack ${name} already published — stack #${[...ids][0]!}`)
    }
    return 'registered'
  }
  return 'unproven'
}

/** Register the chain's open member PRs as the host's stack object —
 *  `gh stack link` on GitHub, absent everywhere chains are detected
 *  from the base links themselves. `quiet` is the cascade caller:
 *  benign no-ops (<2 open PRs, already registered) print nothing — a
 *  refusal still does, it's real signal about the chain. 'registered'
 *  means the members ended up in a stack — the post-publish membership
 *  readback is the success proof, so an empty one fails, not passes. */
function publishStack(
  name: string,
  members: MemberView[],
  stacks: StackFacade,
  defaultBase: string,
  lines: string[],
  quiet: boolean
): PublishOutcome {
  const open = members.filter((m) => m.pr !== undefined && m.prState === 'OPEN')
  if (open.length < 2) {
    if (!quiet) {
      lines.push(`  stack ${name}: fewer than two open member PRs — nothing to publish`)
    }
    return 'skipped'
  }
  if (stacks.membership !== undefined) {
    const pre = membershipPreflight(name, open, stacks.membership, lines, quiet)
    if (pre === 'refused') {
      return 'failed'
    }
    if (pre === 'registered') {
      return 'registered'
    }
  }
  const chain: StackChainMember[] = open.map((m) => ({
    branch: m.branch,
    base: displayBase(m, defaultBase),
    pr: m.pr,
    headSha: m.headSha,
  }))
  try {
    const hit = stacks.publish?.(chain)
    if (hit === null || hit === undefined) {
      lines.push(`  stack ${name} publish failed — host reported no membership`)
      return 'failed'
    }
    lines.push(`  stack ${name} published — stack #${hit.id}`)
    return 'registered'
  } catch (err) {
    lines.push(`  stack ${name} publish failed — ${(err as Error).message}`)
    return 'failed'
  }
}

/** `bro stack publish [<name>]` — the post-hoc verb: member PRs are
 *  opened by workers after `stack push`, so registering the chain can
 *  only run once ≥2 exist. Resolves the chain's name like merge does
 *  (positional, --name, or the member worktree's own branch). */
function cmdPublish(argv: string[]): void {
  const pos = positionals(argv, NAME_FLAGS)
  const name =
    flag(argv, '--name') ??
    pos[0] ??
    parseStackBranch(gitTry(['branch', '--show-current']).out.trim())?.name
  if (name === undefined || !isStackName(name)) {
    console.error('error: no stack context — pass a name or run inside a member worktree')
    usage()
  }
  const main = mainWorktree()
  const stacks = resolveStacks(main.path)
  if (stacks?.publish === undefined) {
    console.error(
      'error: no connector serves stack publish — GitLab detects chains from base branches itself, plain git has no host'
    )
    process.exitCode = 1
    return
  }
  const rev = resolveReview(main.path)
  const defaultBase = defaultBranchName() ?? main.branch ?? 'main'
  const members = collectMembers(name, main.path, rev)
  if (members.length === 0) {
    console.log(`stack ${name} has no members — nothing to publish`)
    return
  }
  const lines: string[] = []
  if (publishStack(name, members, stacks, defaultBase, lines, false) !== 'registered') {
    process.exitCode = 1
  }
  for (const l of lines) {
    console.log(l)
  }
}

/** Per-member cascade context — the inputs every sync step reads. */
interface SyncCtx {
  root: string
  rev: { repo: string; facade: ReviewFacade } | undefined
  stacks: StackFacade | undefined
  defaultBase: string
  lines: string[]
}

/** The rebase half of a member's cascade step — a platform-rewritten
 *  remote gets a fetch+rebase follow, everything else a local rebase
 *  onto the new base. No rebase owed is a pass. */
function rebaseStep(
  item: SyncPlanItem<MemberView>,
  cascade: StackCascade,
  lines: string[]
): boolean {
  if (!item.rebase) {
    return true
  }
  if (cascade.rebase) {
    return followRemote(item.member, lines)
  }
  return rebaseMember(item, lines)
}

/** One member's cascade step. False when the chain's base==prev-head
 *  invariant broke (a dirty member, a failed move) — the caller drops
 *  the publish tail instead of feeding the host's stack tool a
 *  reject. */
function syncMember(item: SyncPlanItem<MemberView>, ctx: SyncCtx): boolean {
  const m = item.member
  if (m.prState === 'MERGED') {
    retireMerged(m, ctx.root, ctx.lines)
    return true
  }
  if (item.skip) {
    ctx.lines.push(`  ${m.branch} skipped — ${item.skip}`)
    return false
  }
  if (!item.rebase && !item.retarget) {
    return true // in sync — don't even touch the edge file
  }
  const cascade = ctx.stacks?.cascade?.(m) ?? MANUAL_CASCADE
  // The edge is the fork truth planSync reads — it moves only after
  // the member's local work landed. Recording it before a rebase or
  // remote-follow would read a failed rewrite as synced and never
  // reschedule it.
  if (!rebaseStep(item, cascade, ctx.lines)) {
    return false
  }
  updateEdge(m, item.desiredBase, ctx.defaultBase)
  if (!cascade.retarget) {
    return retargetMember(item, ctx.rev, ctx.lines)
  }
  if (item.retarget && m.pr !== undefined) {
    ctx.lines.push(`  ${m.branch} PR retarget → ${item.desiredBase} (platform)`)
  }
  return true
}

/** The sync cascade — shared by `stack sync` and `loop --stack`'s
 *  post-merge step. Per-member cascade ownership comes from the
 *  connector's stacks facade: when the platform already retargeted the
 *  PR (GitLab stacked MRs, GitHub .stack members) the API call is
 *  skipped, and when it also rewrote the remote branch (GitHub) the
 *  local worktree fast-follows instead of rebasing. Returns the
 *  per-member report lines; never throws on a single member's failure
 *  (a conflict stops that member, not the run). `status` is the
 *  optional out-channel: a failed auto-publish (the chain was
 *  publishable but the host refused or couldn't prove membership)
 *  flags `publishFailed` so `stack sync` can exit nonzero — a benign
 *  skip (<2 open PRs, deferred on a broken cascade) never does. */
export function syncStack(
  root: string,
  name: string,
  status?: { publishFailed: boolean }
): string[] {
  const main = mainWorktree()
  const ctx: SyncCtx = {
    root,
    rev: resolveReview(root),
    stacks: resolveStacks(root),
    defaultBase: defaultBranchName() ?? main.branch ?? 'main',
    lines: [],
  }
  const members = collectMembers(name, root, ctx.rev)
  // A clean cascade — nothing skipped, nothing refused — leaves the
  // chain's base==prev-head invariant proven, which is exactly what the
  // host's stack registration demands. A dirty member or a failed move
  // breaks it: defer publish instead of feeding the tool a reject.
  let intact = true
  for (const item of planSync(members, ctx.defaultBase)) {
    if (!syncMember(item, ctx)) {
      intact = false
    }
  }
  const stacks = ctx.stacks
  if (intact && stacks?.publish !== undefined) {
    const outcome = publishStack(name, members, stacks, ctx.defaultBase, ctx.lines, true)
    if (outcome === 'failed' && status !== undefined) {
      status.publishFailed = true
    }
  }
  return ctx.lines
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
    const status = { publishFailed: false }
    const lines = syncStack(main.path, name, status)
    if (lines.length === 0) {
      console.log('  in sync')
    } else {
      for (const l of lines) {
        console.log(l)
      }
    }
    if (status.publishFailed) {
      process.exitCode = 1
    }
  }
}

const MERGE_BOOL_FLAGS = new Set(['--squash', '--merge', '--rebase', '--admin'])

/** `bro stack merge` — land the chain bottom→top through the
 *  connector's own mechanism: `gh stack merge` where the extension
 *  answers, bottom-up `PUT …/merge` on GitLab (the platform retargets
 *  between layers), the same per-layer drive on a bare GitHub remote,
 *  plain `git merge` forge-less. Every OPEN member's review gate is
 *  evaluated BEFORE the first merge call — refusing early keeps even
 *  the per-layer fallback effectively all-or-nothing on the gate axis. */
async function cmdMerge(argv: string[]): Promise<void> {
  const pos = positionals(argv, NAME_FLAGS, { boolFlags: MERGE_BOOL_FLAGS, strict: true })
  const name =
    flag(argv, '--name') ??
    pos[0] ??
    parseStackBranch(gitTry(['branch', '--show-current']).out.trim())?.name
  if (name === undefined || !isStackName(name)) {
    console.error('error: no stack context — pass a name or run inside a member worktree')
    usage()
  }
  const picked = (['--squash', '--merge', '--rebase'] as const).filter((f) => argv.includes(f))
  if (picked.length > 1) {
    console.error(`error: ${picked.join(' ')} — merge strategy flags are exclusive`)
    usage()
  }
  const opts: StackMergeOpts = {
    method: (picked[0]?.slice(2) ?? 'squash') as StackMergeOpts['method'],
    admin: argv.includes('--admin'),
  }
  const main = mainWorktree()
  const trunk = defaultBranchName() ?? main.branch ?? 'main'
  const rev = resolveReview(main.path)
  const stacks = resolveStacks(main.path)
  const members = collectMembers(name, main.path, rev)
  if (members.length === 0) {
    console.log(`stack ${name} has no members — nothing to merge`)
    return
  }
  const live = members.filter((m) => m.prState !== 'MERGED')
  if (live.length === 0) {
    console.log('nothing to merge — every member already landed')
    return
  }
  // The merge set is the contiguous prefix that CAN land — on a review
  // host that means an OPEN PR per member, so a PR-less or closed member
  // breaks the chain (nothing merges past it). Forge-less, every member
  // is mergeable: git lands the whole chain.
  let mergeable = live
  if (rev !== undefined) {
    const cut = live.findIndex((m) => m.pr === undefined || m.prState !== 'OPEN')
    mergeable = cut === -1 ? live : live.slice(0, cut)
    if (mergeable.length === 0) {
      console.error(
        `error: bottom member ${live[0]!.branch} has no OPEN PR — nothing can merge past it`
      )
      process.exitCode = 1
      return
    }
    if (mergeable.length < live.length) {
      console.log(`  ${live[mergeable.length]!.branch} has no OPEN PR — merge stops below it`)
    }
  } else if (stacks?.mergeChain === undefined) {
    console.error('error: no merge path — no review host and no stacks connector serve this repo')
    process.exitCode = 1
    return
  }

  // gate evaluation → merge is one critical section, same as act merge —
  // the slot wraps the checks themselves: taken after them, another merge
  // could move a PR between its gate read and its landing
  const slot = acquireMergeSlot()
  if (slot.kind === 'held') {
    console.error(
      `merge slot held by ${slot.holder} — another session is merging; ` +
        'wait for `bd merge-slot check` to report available'
    )
    process.exitCode = 1
    return
  }
  try {
    // gate every mergeable layer before the first merge — an unresolved
    // thread three layers up must not leave the bottom two landed
    if (rev !== undefined) {
      const act = loadBroConfig(main.path).act
      for (const m of mergeable) {
        const pr = m.pr
        if (pr === undefined) {
          continue // unreachable — the prefix guarantees an OPEN PR
        }
        const state = await fetchPrActState(
          rev.facade,
          { repo: rev.repo, pr },
          {
            ignoreChecks: act.ignoreChecks,
            checkHistory: checkHistory(main.path),
            maxRounds: act.maxRounds,
            docsPaths: act.docsPaths,
            docsMaxRounds: act.docsMaxRounds,
          }
        )
        const gate = evaluateExitGate(state)
        if (!gate.ok) {
          console.error(
            `exit_gate=BLOCKED — refusing to merge; ${rev.facade.prLink(rev.repo, pr)} (${m.branch}) is not ready:`
          )
          for (const b of gate.blockers) {
            console.error(`  blocker: ${b}`)
          }
          process.exitCode = 1
          return
        }
      }
    }
    const chain: StackChainMember[] = mergeable.map((m) => ({
      branch: m.branch,
      base: trunk,
      pr: m.pr,
      headSha: m.headSha,
    }))
    const report =
      stacks?.mergeChain?.(chain, opts) ??
      (rev !== undefined
        ? mergeChainPerLayer(rev.facade, rev.repo, chain, opts, (m) =>
            stacks?.cascade?.(m) ?? MANUAL_CASCADE
          )
        : undefined)
    if (report === undefined) {
      // a stacks facade that declined and no reviews facade to fall
      // back on — git-only connectors always carry mergeChain, so this
      // is the no-connector corner
      console.error('error: stack merge declined — no connector can merge this chain')
      process.exitCode = 1
      return
    }
    for (const l of report.lines) {
      console.log(l)
    }
    // a PR-less member that landed is invisible to sync's MERGED
    // detection — retire it here; members with reviews retire inside
    // the sync pass their host reports
    const mergedSet = new Set(report.merged)
    for (const m of mergeable) {
      if (mergedSet.has(m.branch) && m.pr === undefined) {
        const retireLines: string[] = []
        retireMerged(m, main.path, retireLines)
        for (const l of retireLines) {
          console.log(l)
        }
      }
    }
    // the post-merge cascade: forge-merged retirement, retargets,
    // rebases — same pass `bro stack sync` runs
    for (const l of syncStack(main.path, name)) {
      console.log(l)
    }
  } finally {
    if (slot.kind === 'acquired') {
      releaseMergeSlot()
    }
  }
}

export async function runStackCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'push':
      return cmdPush(rest)
    case 'list':
      return cmdList(rest)
    case 'sync':
      return cmdSync(rest)
    case 'publish':
      return cmdPublish(rest)
    case 'merge':
      return cmdMerge(rest)
    default:
      usage()
  }
}
