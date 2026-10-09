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
  type StackCascade,
  type StackChainMember,
  type StackFacade,
  type StackMergeOpts,
  type StackMergeReport,
} from '@broject/core'
import { stackProbe } from './reviews.ts'

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
      `  ${prLink(resolveRepo([], dir), top.pr)} — stack merged atomically via \`gh stack merge\` (${merged.length} layer${merged.length === 1 ? '' : 's'})`,
    ],
    merged,
  }
}

export function githubStacks(dir: string): StackFacade {
  return {
    openHint: (m) => `gh pr create --base ${m.base}`,
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
  }
}
