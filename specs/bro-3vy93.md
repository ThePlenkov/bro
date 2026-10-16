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
