/**
 * stacks.ts — the `stacks` facade contract plus its shared plumbing.
 *
 * A stack is an ordered chain of branches (bottom→top); the connector
 * owning the repo's host answers which parts of the cascade the
 * PLATFORM already performs — retargeting dependents, rewriting their
 * remote branches, atomic whole-chain merge — so the command layer only
 * does the complement. A forge-less repo gets the same verbs through
 * the built-in git connector's local merge cascade.
 *
 * Platform semantics (spec specs/bro-r6vge.md):
 * - GitHub: `.stack` on the PR payload marks platform-tracked chains;
 *   merging the bottom auto-retargets dependents AND rebases their
 *   remote branches. `gh stack merge <pr>` (extension) is the atomic
 *   all-or-nothing whole-chain merge.
 * - GitLab 19.1+: the platform detects chains from target branches and
 *   retargets the next MR on each merge — bro never retargets there.
 * - plain git: everything is local — rebase and merge are plain git.
 */
import { gitTry } from './git.ts'
import type { MergeOpts, ReviewFacade } from './review.ts'

/** One link in the chain as a merge/sync op needs it — ordered
 *  bottom→top. `pr` absent means the member carries no open review
 *  (forge-less repo, or the member never opened one). */
export interface StackChainMember {
  branch: string
  /** The branch this member lands on — the trunk for every member of
   *  a whole-chain merge. */
  base: string
  pr?: number
  /** Tip sha the gate evaluated — merge pins it, so a head that moved
   *  since collection fails closed inside mergePr. */
  headSha?: string
}

/** Which post-merge cascade steps the platform owns above a merged
 *  member. `retarget` — dependents' declared bases move host-side.
 *  `rebase` — dependents' REMOTE branches are rewritten (the local
 *  complement is fetch + `git rebase` onto the remote tip, never a
 *  rebase+force-push that would double the platform's rewrite). */
export interface StackCascade {
  retarget: boolean
  rebase: boolean
}

/** The pre-facade behavior — the caller performs both steps itself. */
export const MANUAL_CASCADE: StackCascade = { retarget: false, rebase: false }

export interface StackMergeOpts {
  method: MergeOpts['method']
  admin?: boolean
}

export interface StackMergeReport {
  lines: string[]
  /** Member branches that actually landed — the caller retires their
   *  edges and local branches. */
  merged: string[]
}

export interface StackFacade {
  /** The host's "open a review for this member" command — push's hint
   *  line. Undefined → no review surface (plain git): push prints
   *  nothing. */
  openHint?(member: { branch: string; base: string }): string | undefined
  /** Cascade ownership above a member — probed per member, since one
   *  connector answers differently for a platform-tracked chain PR vs
   *  a plain one (GitHub's `.stack` field). Absent → MANUAL_CASCADE. */
  cascade?(member: { branch: string; pr?: number }): StackCascade
  /** Merge the chain through the host's native mechanism — atomic where
   *  the platform has it. Undefined → the caller falls back to
   *  mergeChainPerLayer (the GitLab flow: per-layer is the platform
   *  mechanism, so no `mergeChain` is honest there). */
  mergeChain?(
    members: StackChainMember[],
    opts: StackMergeOpts
  ): StackMergeReport | undefined
}

/** Sync nap — merge paths are commands, not hook probes; same primitive
 *  filelock uses to block on a lock. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Wait out a platform's server-side rebase of a dependent: after the
 *  member below merged, a `rebase`-owning host force-pushes a new head
 *  for this member — merging on the sha the gate saw would fail closed.
 *  Polls `prMeta` until the head moves past `staleSha` or ~30s pass; the
 *  freshest meta is returned either way (a still-stale head simply fails
 *  inside mergePr with the pin error, and a re-run converges). */
function settleRemoteHead(
  rev: ReviewFacade,
  t: { repo: string; pr: number },
  staleSha: string
): { headSha: string; baseRef: string; state: string } {
  const deadline = Date.now() + 30_000
  let meta = rev.prMeta(t)
  while (meta.headSha === staleSha && Date.now() < deadline) {
    sleepSync(1_000)
    meta = rev.prMeta(t)
  }
  return meta
}

/** Per-layer merge — the fallback where no atomic chain merge exists,
 *  and the designed flow on hosts whose platform mechanism IS
 *  bottom-up (GitLab). For each member bottom→top: re-read its meta
 *  (the platform may have rewritten the remote head since collection),
 *  retarget it onto the trunk when the host hasn't already — the
 *  retarget is a no-op where the platform moved first — then merge.
 *  Stops at the first member that won't land; already-landed members
 *  stay landed — partial cascades are reported, never faked. */
export function mergeChainPerLayer(
  rev: ReviewFacade,
  repo: string,
  members: StackChainMember[],
  opts: StackMergeOpts,
  cascade: (m: StackChainMember) => StackCascade = () => MANUAL_CASCADE
): StackMergeReport {
  const lines: string[] = []
  const merged: string[] = []
  for (const m of members) {
    if (m.pr === undefined) {
      lines.push(`  ${m.branch} has no open review — stopping the merge here`)
      break
    }
    const t = { repo, pr: m.pr }
    const link = rev.prLink(repo, m.pr)
    let meta =
      cascade(m).rebase && m.headSha !== undefined
        ? settleRemoteHead(rev, t, m.headSha)
        : rev.prMeta(t)
    if (meta.state !== 'OPEN') {
      // a member read back MERGED means an earlier merge/async landing
      // covered it — count it and keep climbing
      if (meta.state === 'MERGED') {
        lines.push(`  ${link} already merged`)
        merged.push(m.branch)
        continue
      }
      lines.push(`  ${link} is ${meta.state} — stopping the merge here`)
      break
    }
    if (meta.baseRef !== m.base) {
      const ok = rev.retargetPr?.(t, m.base) ?? false
      if (!ok) {
        lines.push(
          `  ${link} still targets ${meta.baseRef} and the host refused the retarget to ${m.base} — stopping`
        )
        break
      }
      lines.push(`  ${link} retargeted → ${m.base}`)
    }
    const after = rev.mergePr(t, {
      method: opts.method,
      expectedHeadSha: meta.headSha,
      admin: opts.admin,
    })
    if (after !== 'MERGED') {
      lines.push(
        `  ${link} accepted but state=${after} — a merge queue still owns it; re-run \`bro stack merge\` to continue`
      )
      break
    }
    lines.push(`  merged ${link}`)
    merged.push(m.branch)
  }
  return { lines, merged }
}

// --- plain-git connector implementation -----------------------------------------

/** The repo's primary worktree — `worktree list --porcelain` reports it
 *  first. Local merges land there; a checkout that isn't clean or isn't
 *  on the trunk refuses — a merge must never surprise the human's
 *  in-flight edit. */
function primaryWorktree(dir: string): { path: string; branch?: string } | undefined {
  const first = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']).out.split('\n\n')[0]
  const path = first?.split('\n').find((l) => l.startsWith('worktree '))?.slice(9).trim()
  if (!path) {
    return undefined
  }
  const branch = first
    .split('\n')
    .find((l) => l.startsWith('branch '))
    ?.slice(7)
    .replace(/^refs\/heads\//, '')
    .trim()
  return { path, branch: branch === '' ? undefined : branch }
}

/** The plain-git stacks facade — the same verbs with no forge at all:
 *  no review hints, a manual cascade, and a local merge cascade that
 *  lands each member into the trunk inside the primary worktree. */
export function gitStacks(dir: string): StackFacade {
  return {
    cascade: () => MANUAL_CASCADE,
    mergeChain(members, opts) {
      // a member carrying a review must land through its host — merging
      // the branch locally would strand the open PR. Decline so the
      // caller's per-layer merge drives the review facade instead.
      if (members.some((m) => m.pr !== undefined)) {
        return undefined
      }
      const lines: string[] = []
      const merged: string[] = []
      const trunk = members[0]?.base
      const main = primaryWorktree(dir)
      if (trunk === undefined || main === undefined) {
        lines.push('  no trunk or worktree resolvable — merge aborted')
        return { lines, merged }
      }
      if (main.branch !== trunk) {
        lines.push(`  primary worktree is on ${main.branch ?? 'detached HEAD'}, not ${trunk} — merge aborted`)
        return { lines, merged }
      }
      const dirty = gitTry(['-C', main.path, 'status', '--porcelain']).out.trim() !== ''
      if (dirty) {
        lines.push(`  ${main.path} has uncommitted changes — merge aborted`)
        return { lines, merged }
      }
      for (const m of members) {
        // squash lands the member as one commit; merge|rebase let git
        // pick ff-vs-merge-commit per layer — a linear chain fast-forwards
        const args =
          opts.method === 'squash'
            ? ['-C', main.path, 'merge', '--squash', m.branch]
            : ['-C', main.path, 'merge', '--ff', '-m', `merge ${m.branch} into ${trunk}`, m.branch]
        const r = gitTry(args)
        if (r.code !== 0) {
          gitTry(['-C', main.path, 'merge', '--abort'])
          lines.push(`  ${m.branch} merge into ${trunk} failed — ${r.err.trim() || 'conflict'}; resolve by hand`)
          break
        }
        if (opts.method === 'squash') {
          const c = gitTry(['-C', main.path, 'commit', '-qm', `merge ${m.branch} into ${trunk}`])
          if (c.code !== 0) {
            lines.push(`  ${m.branch} squash-commit failed — ${c.err.trim()}`)
            break
          }
        }
        lines.push(`  merged ${m.branch} into ${trunk}`)
        merged.push(m.branch)
      }
      return { lines, merged }
    },
  }
}
