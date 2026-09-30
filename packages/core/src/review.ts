/**
 * ReviewFacade — the capability a review-host connector provides: PR/MR
 * state, review threads, checks, merge. Named by domain semantics —
 * threads, checks, mergeable — never vendor API names (no checkRuns,
 * graphql, or notes in the contract). GitHub implements it via `gh`
 * today; a gitlab connector maps MR discussions/pipelines later.
 */

/** A pull/merge request on a review host — `repo` is 'owner/name'. */
export interface PrTarget {
  repo: string
  pr: number
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
  /** Source branch + its tip sha at merge — cleanup maps branches it
   *  can retire onto these. */
  headRef: string
  headSha: string
}

export interface MergedPrInfo {
  title: string
  url: string
  mergedAt: string
  mergeSha: string
}

/** Everything a post-merge debt scan needs about one PR — meta + threads
 *  + labels + updatedAt observed at probe time. `scanMergedPrs` carries
 *  it in one bulk fetch so a repo-wide collect doesn't pay one serial
 *  round-trip per field per PR. */
export interface MergedPrScan {
  info: MergedPrInfo
  threads: ReviewThread[]
  /** Labels + updatedAt at probe time — fresh enough for the labeling
   *  decision and to seed the processed cursor for PRs that get no
   *  label write. */
  labels: string[]
  updatedAt: string | null
}

export interface ScanOpts {
  /** In-flight host-call ceiling — the connector picks a default. */
  concurrency?: number
  /** Called as batches finish — (PRs probed so far, total). */
  onProgress?: (done: number, total: number) => void
}

/** One label write in `labelPrs` — add + remove on a single PR. */
export interface PrLabelOp {
  t: PrTarget
  add: string[]
  remove: string[]
}

/** Selection for mergedPrs — `ids` present (even empty) is an explicit
 *  selection; unmerged ids are warned and skipped by the connector,
 *  not thrown. When every fetch fails the connector throws — a
 *  batch-wide outage is not a selection result. */
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
  /** The PR for the bound dir's checked-out branch — null when the
   *  branch has none or the host is unreachable. */
  currentPr(): { pr: number; state: string; url: string } | null
  /** Open PR numbers whose head is this branch — the loop's "did the
   *  agent open one" probe. */
  prsForBranch(branch: string): number[]
  /** A PR reference in free text (the host's own URL shape) → target —
   *  the prompt-submit probe's way to spot its PRs. Null when the text
   *  names none. */
  parsePrRef(text: string): PrTarget | null

  prMeta(t: PrTarget): PrMeta
  /** Merged-PR detail for harvest — throws when the PR isn't merged. */
  mergedPrInfo(t: PrTarget, mergeSha?: string): MergedPrInfo
  mergedPrs(repo: string, q?: MergedPrQuery): MergedPr[]

  /** Bulk post-merge probe — meta + threads + labels + updatedAt for many
   *  PRs with bounded host calls. Optional fast-path: when absent (or a PR
   *  is missing from the map — a per-PR probe failure) callers fall back
   *  to the per-PR methods, so correctness never depends on the bulk path. */
  scanMergedPrs?(targets: PrTarget[], opts?: ScanOpts): Promise<Map<number, MergedPrScan>>

  /** Bulk label write — each op adds + removes on one PR under bounded
   *  concurrency. Resolves to post-write `updatedAt` per applied PR for
   *  cursor bookkeeping (null when the host can't observe it); PRs absent
   *  from the map are failed writes. Optional — absent → per-PR
   *  addLabel/removeLabel + prUpdatedAt. */
  labelPrs?(
    ops: PrLabelOp[],
    opts?: { concurrency?: number }
  ): Promise<Map<number, string | null>>

  checks(t: PrTarget, requiredOnly?: boolean): CheckInfo[]
  /** Check name → failure-annotation count at a head sha. `null` means
   *  the run exists but its annotations could not be fetched — a caller
   *  that gates on findings must count it as unknown, not zero. An
   *  absent key means the check has no annotations endpoint at all. */
  checkAnnotations(repo: string, headSha: string): Map<string, number | null>
  /** Distinct reviewed head SHAs — pushes that entered the review loop. */
  reviewedShas(t: PrTarget): string[]

  reviewThreads(t: PrTarget): Promise<ReviewThread[]>
  resolveThread(id: string, unresolve?: boolean): void
  replyThread(id: string, body: string): void

  labels(t: PrTarget): string[]
  prUpdatedAt(t: PrTarget): string | null
  /** Idempotent — creates or updates the label in place. */
  createLabel(repo: string, name: string, color: string): void
  addLabel(t: PrTarget, label: string): void
  /** Ensure-absent — removing a label the PR doesn't carry is a no-op. */
  removeLabel(t: PrTarget, label: string): void

  /** The host's "update branch" — merge base into head, pinned to the
   *  seen sha. False when the host refuses (conflict, moved head,
   *  permissions) — the caller treats that as settled. */
  updateBranch(t: PrTarget, expectedHeadSha: string): boolean
  /** Merge + authoritative verify — returns the post-merge state so a
   *  merge-queue hold surfaces as a non-'MERGED' state to the caller. */
  mergePr(t: PrTarget, opts: MergeOpts): string
}
