/**
 * GitLab stacks facade — platform-owned retarget gated on the host's
 * version. Stacked MRs are auto-detected from target branches on GL
 * 19.1+: an MR joins a stack by targeting another open MR's source
 * branch, and when the bottom MR merges the platform retargets the next
 * one to the default branch. Older hosts never retarget — `cascade`
 * answers manual there so sync drives `retargetPr` itself. Remote
 * branches are NOT rewritten either way, so local rebases stay ours.
 * Merging is bottom-up `PUT merge_requests/:iid/merge` via the reviews
 * facade — per-layer IS the platform flow, so no `mergeChain` is
 * declared and the caller's fallback drives it.
 */
import {
  MANUAL_CASCADE,
  shQuote,
  type StackCascade,
  type StackFacade,
} from '@broject/core'
import { glabJson } from './glab.ts'
import { hostFor } from './reviews.ts'

const PLATFORM_RETARGET: StackCascade = { retarget: true, rebase: false }

/** `glab api version` → `{version: "19.1.0-ee", …}` — auto-retarget of
 *  stacked MRs landed in 19.1, so the probe gates the retarget claim.
 *  A host that can't answer reads manual: the retarget stays ours, and
 *  retargetPr is a no-op where the platform did move the base. */
function retargetsOnMerge(dir: string): boolean {
  try {
    const v = glabJson<{ version?: string }>(['api', 'version'], {
      cwd: dir,
      env: { GITLAB_HOST: hostFor(dir) },
    }).version
    const m = /^(\d+)\.(\d+)/.exec(v ?? '')
    return m !== null && (Number(m[1]) > 19 || (Number(m[1]) === 19 && Number(m[2]) >= 1))
  } catch {
    return false
  }
}

export function gitlabStacks(dir: string): StackFacade {
  // the probe is lazy — cascade runs per member, the host answers once
  let retargets: boolean | undefined
  const platformRetargets = (): boolean => (retargets ??= retargetsOnMerge(dir))
  return {
    openHint: (m) => `glab mr create --target-branch ${shQuote(m.base)}`,
    cascade: (m) =>
      m.pr !== undefined && platformRetargets() ? PLATFORM_RETARGET : MANUAL_CASCADE,
  }
}
