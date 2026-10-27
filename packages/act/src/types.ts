/**
 * act domain types — the open-PR review loop. Ported from the act skill's
 * pr-state.ts, same semantics minus the shell plumbing.
 */
import type { CheckInfo, ReviewThread } from '@broject/core'
import type { ReopenedThread } from './reopened.ts'

export type { CheckInfo as PrCheck }

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
  threads: ReviewThread[]
  /** Threads that were resolved in the previous observation and are open
   *  again now — the act loop's reopened-thread cycle-guard. Empty when
   *  there is no previous observation (fail-open). */
  reopenedThreads: ReopenedThread[]
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
  /** The effective round cap — when fixRounds exceeds this, open threads
   *  must defer to debt beads instead of another inline-fix round.
   *  0 = unbounded. Usually act.maxRounds; on a docs-only PR the tighter
   *  of it and act.docsMaxRounds. */
  maxRounds: number
  /** Every file the PR touches matches act.docsPaths — the signal that
   *  swapped in the tighter round cap. Probed only while threads are
   *  open (the cap's sole consumer): false means "not docs-only OR not
   *  probed". */
  docsOnly: boolean
  /** Conditional-ignore alerts — advisory checks (act.ignoreChecks)
   *  that are failing without having earned the quiet ignore (repeated
   *  failure + fresh thread activity). The silent-reviewer signal:
   *  visible, never blocking. */
  alerts: string[]
  /** Host review verdict ('APPROVED' etc.) — undefined when the facade
   *  can't say. Probed lazily via the facade's optional reviewDecision
   *  when meta doesn't carry it (GitLab approvals are a second call). */
  reviewDecision?: string
  /** 'a trusted human's approving review stands on the current head' —
   *  the probe behind act.requireApproval. Latest decision review per
   *  reviewer: head-bound approval, bots excluded, standing
   *  CHANGES_REQUESTED vetoed upstream. Probed lazily via the facade's
   *  optional humanApproved — undefined = unanswerable, which the
   *  gate reads as "not approved" (bro-3vy93). Data, not policy —
   *  the requireApproval flag itself lives on the gate call so a
   *  cached state can never smuggle a stale option through. */
  humanApproval?: boolean
  /** The probe's one-line 'why not' — 'changes requested by …',
   *  'approval predates the head', 'bot-only', 'outside act.approvers'.
   *  Undefined when the verdict is true or unanswerable. */
  humanApprovalReason?: string
  /** The allowlist the verdict was probed under — cache/dedup paths
   *  compare it against the caller's act.approvers so a verdict probed
   *  under a different trust set never serves a stricter caller. */
  humanApprovalApprovers?: string[]
  /** The head the verdict was evaluated against — when set it must
   *  equal headSha; a mismatch means the verdict answers a different
   *  head's question (a mid-fetch push) and never serves. */
  humanApprovalHeadSha?: string
  /** The probe generation that produced the verdict — cached entries
   *  written by a different APPROVAL_PROBE_VERSION answered a different
   *  question and never serve. */
  humanApprovalProbe?: string
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
  docs_only: boolean
  /** Advisory-check alerts — see PrActState.alerts. Surfaced for
   *  visibility; never part of `blockers`. */
  alerts: string[]
  /** Reopened threads — see PrActState.reopenedThreads. These DO block;
   *  the count is here for the report. */
  reopened_threads: number
}
