/**
 * ReviewFacade — the capability a review-host connector provides: PR/MR
 * state, review threads, checks, merge. Named by domain semantics —
 * threads, checks, mergeable — never vendor API names (no checkRuns,
 * graphql, or notes in the contract). GitHub implements it via `gh`
 * today; a gitlab connector maps MR discussions/pipelines later.
 */

/** A pull/merge request on a review host. */
export interface PrTarget {
  owner: string
  repo: string
  pr: number
}

export interface RepoRef {
  owner: string
  repo: string
}

/** Normalized PR head state — vendor enums collapsed to uppercase. */
export interface PrMeta {
  state: string // OPEN | MERGED | CLOSED
  isDraft: boolean
  url: string
  headSha: string
  headRef: string
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN
  mergeState: string
}

/** One status check on the PR head — name + settled verdict. */
export interface CheckInfo {
  name: string
  state: string
  /** Rollup bucket — pass | fail | pending | skipping | cancel. */
  bucket: string
}

export interface ReviewComment {
  author: string
  bot: boolean
  path: string | null
  line: number | null
  body: string
  createdAt: string
}

/** One review thread — consumers only ever read the first comment, so
 *  the facade exposes it directly rather than a comments array. */
export interface ReviewThread {
  id: string
  resolved: boolean
  outdated: boolean
  comment: ReviewComment | null
}

export interface MergedPr {
  number: number
  mergedAt: string
  updatedAt: string | null
  author: string
  labels: string[]
}

export interface MergedPrInfo {
  title: string
  url: string
  mergedAt: string
  mergeSha: string
}

/** Selection for mergedPrs — `ids` wins over the list filters; unmerged
 *  ids are warned and skipped by the connector, not thrown. */
export interface MergedPrQuery {
  ids?: number[]
  author?: string
  label?: string
  limit?: number
}

export interface MergeOpts {
  method: 'squash' | 'merge' | 'rebase'
  /** Pin the merge to the sha the gate evaluated — a head that moved
   *  since fails closed instead of landing an unseen commit. */
  expectedHeadSha: string
  deleteBranch?: boolean
  admin?: boolean
}

export interface ReviewFacade {
  /** 'owner/repo' — from positional args or the bound dir's remote. */
  resolveRepo(positional?: string[]): string
  /** Clickable PR reference for user-facing output — vendor URL shape. */
  prLink(ownerRepo: string, pr: number): string

  prMeta(t: PrTarget): PrMeta
  /** Merged-PR detail for harvest — throws when the PR isn't merged. */
  mergedPrInfo(t: PrTarget, mergeSha?: string): MergedPrInfo
  mergedPrs(ref: RepoRef, q?: MergedPrQuery): MergedPr[]

  checks(t: PrTarget, requiredOnly?: boolean): CheckInfo[]
  /** Check name → failure-annotation count at a head sha. An absent key
   *  means the check has no annotations endpoint — nothing is unknown
   *  about it. */
  checkAnnotations(ref: RepoRef, headSha: string): Map<string, number>
  /** Distinct reviewed head SHAs — pushes that entered the review loop. */
  reviewedShas(t: PrTarget): string[]

  reviewThreads(t: PrTarget): Promise<ReviewThread[]>
  resolveThread(id: string, unresolve?: boolean): void
  replyThread(id: string, body: string): void

  labels(t: PrTarget): string[]
  prUpdatedAt(t: PrTarget): string | null
  /** Idempotent — creates or updates the label in place. */
  createLabel(ref: RepoRef, name: string, color: string): void
  addLabel(t: PrTarget, label: string): void
  removeLabel(t: PrTarget, label: string): void

  /** The host's "update branch" — merge base into head, pinned to the
   *  seen sha. False when the host refuses (conflict, moved head,
   *  permissions) — the caller treats that as settled. */
  updateBranch(t: PrTarget, expectedHeadSha: string): boolean
  /** Merge + authoritative verify — returns the post-merge state so a
   *  merge-queue hold surfaces as a non-'MERGED' state to the caller. */
  mergePr(t: PrTarget, opts: MergeOpts): string
}
