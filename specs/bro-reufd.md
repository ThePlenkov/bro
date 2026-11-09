# bro-reufd — rig next judged blocked-ness by ready-page membership

`rigNext` answered "is this open bead actionable" as membership in
`store.ready()` — a backend-paginated front page (bd default ~100).
With a 680-deep queue, every honest fixer bead past the cut read
`blocked — dep-gated or deferred`, so `fixerVerdictRefusal` refused
every drive spawn and `act` never ran on those PRs.

Fix: a known id is judged directly — non-open status, open `blocked`
deps via `neighbors(id, down)`, live `defer_until`, `gt:slot` label —
never page membership. The ready page still drives the no-arg focus
read, which is its actual contract.

## Verify

- e2e (`rig-next.e2e.test.ts`): dep-gated on a live blocker row,
  a closed dep alone does not gate, deferred-until parks,
  `gt:slot` parks, `blocked`/`in_progress`-foreign statuses park,
  an open item past the fake's `readyLimit` page still steps.
- live queue: `rig next bro-y5dzw` on the 680-deep store answered
  `step` where the membership test answered `blocked`.
