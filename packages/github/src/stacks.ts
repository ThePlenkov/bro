/**
 * GitHub stacks facade — the platform's stacked-PR feature behind bro's
 * connector contract. Two capability tiers, probed honestly:
 *
 * - The platform tracks chains whose PRs target each other (the
 *   `.stack` field on the PR read). Merging a member auto-retargets its
 *   dependents AND rebases their remote branches server-side — so
 *   `cascade` answers "platform owns both" per member by probing that
 *   field, the same read `mergePr` uses to pick merge-async.
 * - The `gh stack` extension adds the atomic op: `gh stack merge <pr>`
 *   lands that PR and every unmerged PR below it in one all-or-nothing
 *   call — the ~30min per-layer merge+retarget+CI-rerun cascade in one
 *   step. Absent the extension the facade declines (`undefined`) and
 *   the caller's per-layer merge covers it.
 */
import {
  ghTry,
  MANUAL_CASCADE,
  prLink,
  resolveRepo,
  shQuote,
  type StackCascade,
  type StackChainMember,
  type StackFacade,
  type StackMembership,
  type StackMergeOpts,
  type StackMergeReport,
} from '@broject/core'
import { stackMembership, stackProbe } from './reviews.ts'

const PLATFORM_CASCADE: StackCascade = { retarget: true, rebase: true }

/** Is the `gh stack` extension installed? `gh extension list` prints
 *  `gh stack\tgithub/gh-stack\tvX.Y.Z` rows; a failed listing reads as
 *  "not installed" — never throw on a detection probe. */
function ghStackInstalled(dir: string): boolean {
  const r = ghTry(['extension', 'list'], dir)
  return r.code === 0 && /^gh stack\t/m.test(r.out)
}

/** `gh stack merge <top> --yes` — one all-or-nothing call landing the
 *  chain up to the top member's PR. Returns undefined when the native
 *  path can't serve (extension absent, exit 2 "not in a stack", exit 9
 *  "stacked PRs unavailable") — the caller's per-layer merge is the
 *  fallback; any other failure throws with gh's own stderr. */
function ghStackMerge(
  dir: string,
  members: StackChainMember[],
  opts: StackMergeOpts
): StackMergeReport | undefined {
  // gh-stack has no admin bypass — "bypassing merge requirements is not
  // supported for stacks" — so an --admin merge is only honest per-layer
  if (!ghStackInstalled(dir) || opts.admin === true) {
    return undefined
  }
  const top = members.filter((m) => m.pr !== undefined).at(-1)
  if (top?.pr === undefined) {
    return undefined
  }
  // resolve the repo before the merge call — a `gh repo view` failure
  // after `gh stack merge` landed would throw with the chain already
  // merged, and the caller would skip retirement and the sync cascade
  const repo = resolveRepo([], dir)
  const r = ghTry(['stack', 'merge', String(top.pr), '--yes', `--${opts.method}`], dir)
  if (r.code === 2 || r.code === 9) {
    return undefined
  }
  if (r.code !== 0) {
    throw new Error(`gh stack merge failed (${r.code}): ${r.err || r.out.trim()}`)
  }
  const merged = members.filter((m) => m.pr !== undefined).map((m) => m.branch)
  return {
    lines: [
      `  ${prLink(repo, top.pr)} — stack merged atomically via \`gh stack merge\` (${merged.length} layer${merged.length === 1 ? '' : 's'})`,
    ],
    merged,
  }
}

/** `gh stack link <prs…>` — the extension's external-manager verb:
 *  members already inside a stack are skipped, the rest create or grow
 *  it in bottom→top order. bro owns the branches, so link is the only
 *  write path — `gh stack` state/refresh/push would fight it. The repo
 *  resolves before the call (same rationale as ghStackMerge): a
 *  repo-view failure after link registered the chain would throw with
 *  the work already done. The bottom member's `.stack` re-read is the
 *  success proof — the tool's exit, not its stdout, is authoritative. */
function ghStackLink(dir: string, members: StackChainMember[]): StackMembership | null {
  if (!ghStackInstalled(dir)) {
    throw new Error(
      'gh-stack extension not installed — `gh extension install github/gh-stack` adds `gh stack link`'
    )
  }
  const prs = members.filter((m) => m.pr !== undefined).map((m) => m.pr!)
  if (prs.length === 0) {
    return null
  }
  const repo = resolveRepo([], dir)
  const r = ghTry(['stack', 'link', ...prs.map(String)], dir)
  if (r.code !== 0) {
    throw new Error(`gh stack link ${prs.join(' ')} failed (${r.code}): ${r.err || r.out.trim()}`)
  }
  return stackMembership({ repo, pr: prs[0]! })
}

export function githubStacks(dir: string): StackFacade {
  return {
    openHint: (m) => `gh pr create --base ${shQuote(m.base)}`,
    cascade(m) {
      const pr = m.pr
      if (pr === undefined) {
        return MANUAL_CASCADE
      }
      // `.stack` on the PR marks a platform-tracked chain — such a
      // member's dependents were retargeted AND remote-rebased by the
      // merge below. A probe failure reads manual, the safe answer.
      try {
        const repo = resolveRepo([], dir)
        return stackProbe({ repo, pr }).stacked ? PLATFORM_CASCADE : MANUAL_CASCADE
      } catch {
        return MANUAL_CASCADE
      }
    },
    mergeChain: (members, opts) => ghStackMerge(dir, members, opts),
    membership(m) {
      if (m.pr === undefined) {
        return null
      }
      try {
        return stackMembership({ repo: resolveRepo([], dir), pr: m.pr })
      } catch {
        return null
      }
    },
    publish: (members) => ghStackLink(dir, members),
  }
}
