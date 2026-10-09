/**
 * GitLab stacks facade — the platform owns the chain. Stacked MRs are
 * auto-detected from target branches (GL 19.1+): an MR joins a stack by
 * targeting another open MR's source branch, and when the bottom MR
 * merges the platform retargets the next one to the default branch. So
 * bro never retargets on GitLab — `cascade` says so — while remote
 * branches are NOT rewritten, so local rebases stay ours. Merging is
 * bottom-up `PUT merge_requests/:iid/merge` via the reviews facade —
 * per-layer IS the platform flow, so no `mergeChain` is declared and
 * the caller's fallback drives it.
 */
import {
  MANUAL_CASCADE,
  type StackCascade,
  type StackFacade,
} from '@broject/core'

const PLATFORM_RETARGET: StackCascade = { retarget: true, rebase: false }

export function gitlabStacks(_dir: string): StackFacade {
  return {
    openHint: (m) => `glab mr create --target-branch ${m.base}`,
    cascade: (m) => (m.pr === undefined ? MANUAL_CASCADE : PLATFORM_RETARGET),
  }
}
