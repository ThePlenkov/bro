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
  `comments{pullRequestReview{id}}` attribution, following each
  thread's `comments` connection past its first:100 page (a veto's
  only attributed comment can sit beyond the cap — attribution is
  never read off a truncated window). A body-only veto references
  zero threads.
- **Stale** = ≥1 referenced thread AND every referenced thread
  `isResolved && isOutdated`. Resolved-but-not-outdated does NOT
  count — a "won't fix" resolve on current code is not evidence the
  veto's ask went stale. **Zero referenced threads is NOT stale** —
  a body-only veto's objection can live in the review body with no
  thread anchor, and staleness needs positive evidence, never
  absence of it (dismissal is destructive-leaning; every uncertainty
  resolves toward LIVE — codeant-ai on PR #1020). `threads` rides
  the record so the report can say "0 referenced threads —
  body-only veto" honestly instead of implying thread evidence
  existed.
- **The review body rides the record** (`VetoReview.body`) because
  thread refs only cover INLINE objections — a body-level ask ("also
  run a security audit") is invisible to the stale rule even when
  every thread settled (coderabbit-ai on PR #1020). `act status`
  prints the WHOLE body under each veto and `act dismiss` prints it
  BEFORE mutating — never truncated, since any cutoff could hide the
  objection that matters past it — so the dismissal, which stays an
  explicit operator/agent act, is an informed human decision, not a
  blind one. The tool provides evidence; it cannot machine-verify
  free text, so a body that may carry an independent objection is the
  human's call to dismiss or leave.
- **Dismissal re-verifies before mutating**: `act dismiss` re-reads
  `vetoReviews` immediately before the dismissal loop AND re-probes
  each candidate immediately before its own `dismissReview` call —
  a thread reopened (or objection reposted) at any point since the
  candidate's last probe is skipped and named, so the residual window
  narrows to each entry's own probe→mutation gap. No host lock exists
  to close it fully.
- **Fail closed**: a truncated reviews, threads, or comments page
  throws — the state fetch degrades `vetoReviews` to undefined (the
  gate still blocks on `reviewDecision`; only the enumeration is
  lost), and `act dismiss` errors rather than dismissing on a
  partial read. An unenumerable veto is never "nothing to dismiss".

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
- A veto with ZERO referenced threads (body-only objection) →
  `stale === false` — no thread anchor is not proof the ask went
  stale; `act dismiss` refuses it.
- A veto whose only attributed comment sits past a thread's
  comments:first:100 page → still attributed → `stale` computed on
  the full comment set, never the truncated window.
- A veto stale at the first `act dismiss` probe but live at the
  pre-mutation re-read → skipped and named, never dismissed off the
  stale snapshot.
- A veto going live DURING an earlier dismissal in the same batch →
  caught by its own pre-mutation re-probe → skipped, never dismissed
  off the batch snapshot.
- Latest-per-reviewer fold: an older CR superseded by the same
  reviewer's APPROVED (or DISMISSED) is not a standing veto.
- `dismissReview` sends `dismissPullRequestReview` with the review
  node id + message; GraphQL errors propagate.
- APPROVED / REVIEW_REQUIRED / absent decision → the probe never
  runs (`vetoReviews` stays undefined, zero host calls).
