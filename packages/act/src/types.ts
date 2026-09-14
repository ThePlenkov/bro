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
  /** Non-reviewer checks that are not passing/skipped/neutral. */
  ciPending: number
  /** SAST check runs with failure-level annotations. */
  sastPending: number
  /** SAST checks whose annotations could not be fetched. */
  sastUnknown: number
}

export interface ExitGate {
  ok: boolean
  blockers: string[]
  open_threads: number
  ci_pending: number
  sast_pending: number
  sast_unknown: number
  is_draft: boolean
}
