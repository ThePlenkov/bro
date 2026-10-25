# bro-3vy93 — act.requireApproval: human sign-off before auto-merge

The exit gate checks threads, CI, pending reviewers, SAST,
mergeability, and draft state — but never the host's review verdict.
A rig running `drive.merge: auto` lands agent output with zero human
sign-off, which is the wrong default for hostile-input threat models
(a malicious bead, prompt injection through review content).

## Change

`act.requireApproval: boolean` (default `false`) — when true, the
exit gate also requires the PR's review verdict to be `APPROVED`:

- `PrMeta.reviewDecision?: string` carries the host verdict
  ('APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'). GitHub gets
  it free on the existing `prMeta` GraphQL read.
- `ReviewFacade.reviewDecision?(t)` (+ async twin) is the lazy probe
  for hosts whose verdict lives elsewhere — GitLab maps its
  `merge_requests/:iid/approvals` `approved` flag, fetched ONLY when
  the gate is on (no per-poll tax when off).
- `PrActState` gains `reviewDecision` + the resolved
  `requireApproval`; every `fetchPrActState` call site threads the
  config value through (same pattern as `maxRounds`).
- `evaluateExitGate` blocks an OPEN PR with
  `no human approval — act.requireApproval requires APPROVED (got
  <verdict|none>)`. An unanswerable probe — no facade method, a host
  error — reads as `none`, never as a pass.
- Non-OPEN states bypass the check like every other gate input.

## Invariants

- Default off — existing bot-only auto-merge behavior is unchanged.
- Absent verdict never passes: "can't tell" is "not approved".
- The GitLab approvals probe is lazy — the config being off costs
  zero host calls; on GitHub it costs none either way.

## Rejection test

- `requireApproval: true` + APPROVED → gate ok; REVIEW_REQUIRED /
  CHANGES_REQUESTED / undefined → blocked with the verdict named.
- `requireApproval: false` + CHANGES_REQUESTED → ok (flag is the
  whole contract).

## Round 2 — current-head / current-verdict (audit 2026-10-18)

The audit (bro-l8c4f) found the first cut under-binds the verdict:
`humanApproved` enumerated `reviews(first:50, states:[APPROVED])` and
accepted any `User`-authored approval — a *historical* approval on a
superseded head still passed after new pushes, and an actor's newer
CHANGES_REQUESTED didn't cancel their older approval. Pagination was
absent, and `User` equated "human" with a machine account's typename.

Tightened semantics — `requireApproval: true` now means a **trusted
human approval on the current head with the latest review per
reviewer**:

- The GitHub probe pages `reviews(first:100,
  states:[APPROVED,CHANGES_REQUESTED,DISMISSED])` to exhaustion and
  folds to the latest review per reviewer (comment reviews are not
  decisions and never enter the set). A DISMISSED latest is a
  revocation — it suppresses that reviewer's earlier approvals rather
  than letting an older approval resurface beneath it.
- An approval counts only when the review's `commit.oid` equals the
  current `headRefOid` — an approval on a pushed-past head is stale,
  not a sign-off.
- Any reviewer's standing CHANGES_REQUESTED blocks, regardless of
  which head it reviewed — an unanswered objection survives pushes.
- Only `__typename: 'User'` approvals count — bots never satisfy the
  gate. `User` still is not proven-human: `act.approvers` (string
  logins, default `[]` = any human) narrows "counts" to named trusted
  reviewers for rigs where a machine `User` account also reviews.
- The probe answer is `{ approved, reason }` — the blocker names why
  ('changes requested by …', 'approval predates head', 'bot-only',
  'outside act.approvers', 'unanswerable'), never a bare no.
- GitLab keeps the approvals-endpoint verdict (bot flag + `approvers`
  username filter): per-approval SHAs are not exposed, so current-head
  binding is delegated to the project's *reset approvals on push*
  rule — the documented server-side boundary, same class as branch
  protection.
- Canonical docs: `requireApproval`/`approvers` join the
  configuration table and the act/drive guides — opt-in, default,
  bot-only, unknown probe, and the "gate green" ≠ "human approved"
  distinction are stated, with the since-version named.

### Round-2 rejection test

- Human approval on SHA A + a new head B → blocked (stale approval).
- Older APPROVED + the same actor's newer CHANGES_REQUESTED → blocked.
- Bot-only approvals, no approvals, and an unanswerable probe →
  blocked. A human approval on the current head → passes.
- `act.approvers: ['alice']` + head approval from `bob` (User) →
  blocked; from `alice` → passes.
- Pagination: a qualifying approval past the first reviews page is
  still found.
- `requireApproval: false` → no probe call, gate unchanged.
