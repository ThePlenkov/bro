/**
 * ReviewFacade — the capability a review-host connector provides: PR/MR
 * state, review threads, checks, merge. Named by domain semantics —
 * threads, checks, mergeable — never vendor API names (no checkRuns,
 * graphql, or notes in the contract). GitHub implements it via `gh`,
 * GitLab via `glab` (MR discussions, pipelines, diff versions).
 */

/** A pull/merge request on a review host — `repo` is the host's project
 *  path: 'owner/name' on GitHub; GitLab nests ('group/sub/proj'). */
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
  /** Target branch — stack sync reads it to decide whether a retarget
   *  is needed at all. */
  baseRef: string
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
 *  not thrown. Duplicates collapse — each id yields at most one row.
 *  When every fetch fails the connector throws — a
 *  batch-wide outage is not a selection result. */
export interface MergedPrQuery {
  ids?: number[]
  author?: string
  label?: string
  limit?: number
  /** List path only: merged at/after this ISO stamp, pushed into the
   *  host query so the `limit` cap can't crowd window-eligible PRs out
   *  behind post-merge updates (hosts cap by updated_at). The
   *  explicit-ids path ignores it — named PRs are the selection. A
   *  caller that needs a hard guarantee still filters the result. */
  mergedSince?: string
}

export interface MergeOpts {
  method: 'squash' | 'merge' | 'rebase'
  /** Pin the merge to the sha the gate evaluated — a head that moved
   *  since fails closed instead of landing an unseen commit. */
  expectedHeadSha: string
  deleteBranch?: boolean
  admin?: boolean
}

export interface EnqueueOpts {
  /** Checkout holding the PR head — checkout-bound queue CLIs
   *  (graphite `gt`) merge from the worktree, not the API. */
  dir?: string
  /** The PR's head branch — the connector verifies the checkout is on
   *  it before running anything that merges "the current stack". */
  headRef?: string
  /** The sha the gate evaluated — a head that moved since must refuse
   *  the signal rather than queue a commit the gate never saw. */
  expectedHeadSha?: string
}

/** MergeQueueFacade — an external merge queue's capability: park a PR
 *  on the queue instead of direct-merging it. Opt-in by name only
 *  (`connectors.mergeQueue`) — a queue is never auto-detected, so a
 *  connector providing it must also be `optIn`. */
export interface MergeQueueFacade {
  /** Park the PR on the connector's queue. Returns 'merged' when the
   *  call landed the PR outright (a queue-less repo merges directly) —
   *  the honest answer from a state re-read, never a guess. Throws on
   *  refusal: a failed enqueue is a failed merge, never "maybe queued". */
  enqueue(t: PrTarget, opts?: EnqueueOpts): 'enqueued' | 'merged'
}

export interface ReviewFacade {
  /** 'owner/repo' — from positional args or the bound dir's remote. */
  resolveRepo(positional?: string[]): string
  /** Async twin — probe paths must not serialize behind a sync `gh`. */
  resolveRepoAsync?(positional?: string[]): Promise<string>
  /** Clickable PR reference for user-facing output — vendor URL shape. */
  prLink(ownerRepo: string, pr: number): string
  /** The PR for the bound dir's checked-out branch — null when the
   *  branch has none or the host is unreachable. */
  currentPr(): { pr: number; state: string; url: string } | null
  currentPrAsync?(): Promise<{ pr: number; state: string; url: string } | null>
  /** PR numbers whose head is this branch — the loop's "did the agent
   *  open one" probe. Default `open`; `all` adds merged/closed PRs in
   *  the host's listing order — stack sync needs them to see a member's
   *  merge land. */
  prsForBranch(branch: string, state?: 'open' | 'all'): number[]
  /** A PR reference in free text (the host's own URL shape) → target —
   *  the prompt-submit probe's way to spot its PRs. Null when the text
   *  names none. */
  parsePrRef(text: string): PrTarget | null

  prMeta(t: PrTarget): PrMeta
  /** Async twins of the gate-path reads — sync spawnSync methods block
   *  the event loop AND every other probe's timeout timer when they run
   *  inside a hook sweep. Optional: `fetchPrActState` falls back to the
   *  sync method wrapped in a resolved Promise for hosts without them. */
  prMetaAsync?(t: PrTarget): Promise<PrMeta>
  /** Merged-PR detail for harvest — throws when the PR isn't merged or a
   *  MERGED PR reports no mergedAt. */
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

  /** Paths this PR touches — the diff's file list. Optional — a host
   *  without the capability leaves callers treating the PR as unknown
   *  scope (never "docs-only"). */
  prFiles?(t: PrTarget): string[]

  checks(t: PrTarget, requiredOnly?: boolean): CheckInfo[]
  checksAsync?(t: PrTarget, requiredOnly?: boolean): Promise<CheckInfo[]>
  /** Check name → failure-annotation count at a head sha. `null` means
   *  the run exists but its annotations could not be fetched — a caller
   *  that gates on findings must count it as unknown, not zero. An
   *  absent key means the check has no annotations endpoint at all. */
  checkAnnotations(repo: string, headSha: string): Map<string, number | null>
  checkAnnotationsAsync?(repo: string, headSha: string): Promise<Map<string, number | null>>
  /** Distinct reviewed head SHAs — pushes that entered the review loop. */
  reviewedShas(t: PrTarget): string[]
  reviewedShasAsync?(t: PrTarget): Promise<string[]>
  /** prFiles async twin — docsOnlyPr awaits it on the gate path. */
  prFilesAsync?(t: PrTarget): Promise<string[]>

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

  /** Wire the PR's auto-close onto tracker items — the host's closing
   *  keyword joined into the body, idempotent per ref ('Fixes #42' on
   *  github). refs are tracker-native item ids as the tasks facade
   *  reports them. Optional — a host without body edits can't wire
   *  auto-close; callers treat absence as "items stamped, links
   *  skipped". */
  linkCloses?(t: PrTarget, refs: string[]): void

  /** Retarget the PR's base branch (stack sync's half of a rebase — the
   *  branch moves locally, the PR's declared base moves here). False
   *  when the host refuses. Optional — a host without the capability
   *  leaves sync reporting the PR as un-retargetable. */
  retargetPr?(t: PrTarget, base: string): boolean
  /** The host's "update branch" — merge base into head, pinned to the
   *  seen sha. False when the host refuses (conflict, moved head,
   *  permissions) — the caller treats that as settled. */
  updateBranch(t: PrTarget, expectedHeadSha: string): boolean
  /** Merge + authoritative verify — returns the post-merge state so a
   *  merge-queue hold surfaces as a non-'MERGED' state to the caller. */
  mergePr(t: PrTarget, opts: MergeOpts): string
}
