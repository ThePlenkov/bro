# bro-n1foa — reviewDecision veto: stale-review detection + dismiss

GitHub's `reviewDecision` is a third axis beside threads and checks —
a standing CHANGES_REQUESTED vetoes the merge on the host even when
every thread resolved (PR #931: `open_threads=0`, `gh pr merge`
refused on kody-ai's verdict until `dismissPullRequestReview`
`PRR_kwDOUamqtM8AAAABWay27Q` cleared it).

PR #976 landed the gate half: `reviewDecision=CHANGES_REQUESTED` is a
named blocker and `act status` prints `review_decision=`. What was
missing is the *dismiss path* — the gate said "dismiss a stale review"
but nothing could say WHICH review was stale or clear it.

## Change

- `ReviewFacade.vetoReviews?(t)` (+ the domain `VetoReview`) — the
  standing CHANGES_REQUESTED reviews on the PR, each annotated with
  whether its referenced threads are all resolved+outdated. Lazy like
  `humanApproved`: probed only when `reviewDecision` reads
  CHANGES_REQUESTED, so every other gate read pays nothing.
- `ReviewFacade.dismissReview?(t, reviewId, message)` — the host's
  review-dismissal mutation (`dismissPullRequestReview`). Optional —
  GitLab has no review-dismissal concept and simply doesn't implement
  it; `act dismiss` reports the host as unsupported.
- `PrActState.vetoReviews` carries the probe result; the
  CHANGES_REQUESTED blocker names the stale vs live split and the
  `bro act dismiss` hint instead of the generic "dismiss a stale
  review".
- `bro act dismiss [PR] [--dry-run] [--message T]` — dismiss every
  *stale* standing veto. Strict PR resolution (a mutation never
  guesses), `--dry-run` lists without touching the host, a live veto
  is refused by the stale filter rather than by a flag the caller
  must remember.

## Semantics

- **Standing** = latest decision review per reviewer, the same fold
  `headApprovalVerdict` applies (APPROVED | CHANGES_REQUESTED |
  DISMISSED; later `submittedAt` wins, ties fall to list order;
  comment-only reviews never enter). A DISMISSED latest is a
  revocation — it suppresses that reviewer's older veto rather than
  letting it resurface. Unattributable authors key on the review id —
  each stands alone (the veto axis doesn't need proven-human the way
  the approval axis does; a deleted account's objection still blocks
  the host merge).
- **Referenced threads** = review threads containing ≥1 comment whose
  `pullRequestReview.id` is the veto's node id. A review's own
  `comments` connection can't answer this — review comments carry no
  thread back-reference — so the probe pages `reviewThreads` with
  `comments{pullRequestReview{id}}` attribution. A body-only veto
  references zero threads and is therefore stale (vacuous truth — the
  #931 evidence review had no comments at all; its findings arrived
  as separate COMMENTED reviews whose threads all resolved).
- **Stale** = every referenced thread `isResolved && isOutdated`.
  Resolved-but-not-outdated does NOT count — a "won't fix" resolve on
  current code is not evidence the veto's ask went stale. `threads`
  rides the record so the report can say "0 referenced threads"
  honestly instead of implying thread evidence existed.
- **Fail closed**: a truncated reviews or threads page throws — the
  state fetch degrades `vetoReviews` to undefined (the gate still
  blocks on `reviewDecision`; only the enumeration is lost), and
  `act dismiss` errors rather than dismissing on a partial read.
  An unenumerable veto is never "nothing to dismiss".

## Invariants

- Detection is read-only and lazy — a PR without a standing veto pays
  zero extra host calls.
- Dismissal is explicit and stale-only — `act dismiss` cannot clear a
  live veto; that stays a human/re-review decision on the host.
- The gate verdict never depends on the probe: `reviewDecision` alone
  blocks; `vetoReviews` only enriches the blocker text and feeds the
  dismiss command.
- Dismissal invalidates the shared act-state feed so the next poll
  sees the moved `reviewDecision`, not a cached veto.

## Rejection test

- `reviewDecision=CHANGES_REQUESTED` + a standing veto whose threads
  are all resolved+outdated → `vetoReviews[0].stale === true`, the
  blocker names the author and the dismiss hint.
- A veto with any unresolved or not-outdated referenced thread →
  `stale === false`; the blocker says "wait for re-review" and
  `act dismiss` refuses it.
- Latest-per-reviewer fold: an older CR superseded by the same
  reviewer's APPROVED (or DISMISSED) is not a standing veto.
- `dismissReview` sends `dismissPullRequestReview` with the review
  node id + message; GraphQL errors propagate.
- APPROVED / REVIEW_REQUIRED / absent decision → the probe never
  runs (`vetoReviews` stays undefined, zero host calls).
