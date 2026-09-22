/**
 * act domain types — the open-PR review loop. Ported from the act skill's
 * pr-state.ts, same semantics minus the shell plumbing.
 */
import type { ReviewThreadNode } from '@bro/debt'

export interface PrCheck {
  name: string
  state: string
  bucket: string
}

export interface PrActState {
  pr: number
  url: string
  headSha: string
  headRef: string
  state: string
  isDraft: boolean
  mergeable: string
  mergeState: string
  openThreads: number
  threads: ReviewThreadNode[]
  /** Non-reviewer checks still running/queued — all checks, not just required. */
  ciPending: number
  /** Non-reviewer checks settled red (failure/cancelled/timed out). */
  ciFailing: number
  /** AI reviewer checks still running — they may yet open threads. */
  reviewersPending: number
  /** AI reviewer checks that failed — the review may never have run. */
  reviewersFailing: number
  /** SAST check runs with failure-level annotations. */
  sastPending: number
  /** SAST checks whose annotations could not be fetched. */
  sastUnknown: number
  /** Pushes made after the first review comment landed — the act loop's
   *  round counter. */
  fixRounds: number
  /** act.maxRounds — when fixRounds exceeds this, open threads must defer
   *  to debt beads instead of another inline-fix round. 0 = unbounded. */
  maxRounds: number
}

export interface ExitGate {
  ok: boolean
  blockers: string[]
  open_threads: number
  ci_pending: number
  ci_failing: number
  reviewers_pending: number
  reviewers_failing: number
  sast_pending: number
  sast_unknown: number
  is_draft: boolean
  fix_rounds: number
  max_rounds: number
}
