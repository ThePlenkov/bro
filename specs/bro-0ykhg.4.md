# bro-0ykhg.4 — brouter outcomes: the act verdict flows back into the router

Child of bro-0ykhg (specs/bro-0ykhg.md). Feeds bro-0ykhg.1 (`score`),
bro-0ykhg.2 (T1 recall), bro-0ykhg.3 (invalidation), bro-0ykhg.5 (oracle).

## Problem

The router journals what it picked, never how it went. bro already knows the
result of every task it gated: the PR merged or not, how many act rounds,
how many review threads, what the run cost. That signal is bro's unique
position — no request-level router has it — and today it is dropped.

## Design

**The decision id.** Every `brouter route`/`ask`/spawn decision gets a
`decisionId` (already the journal row's identity); bro pins it on the
spawned worker's registry entry and on the bead (`router:decision=<id>`).

**The router's surface, bro as reporter.** The router runs without beads,
so it never reads act. bro reports:

```text
brouter outcome <decisionId> --result merged|failed|abandoned|parked \
  [--rounds N] [--threads N] [--cost USD] [--tokens N] [--wall-ms N] [--json]
```

(also the library call `recordOutcome()`), invoked by `bro review act wait
--merge` on merge, by the drive/loop reapers on abandon, and by the fleet on
a terminal exit cause.

**The table.** `outcomes(decision_id, route, provider, model, task_text,
features_json, result, rounds, threads, cost, tokens, wall_ms, at)` in
router.db + an FTS5 index on `task_text` for T1. Missing measures are NULL
(unknown), never 0.

**The read-model.** `P(success | route, features)` = merged-first-time rate
per (route, feature bucket), with a Beta(1,1) prior and the row count beside
it; `brouter stats outcomes [--json]` prints it. "Success" is configurable
in the formula (`success: merged` | `merged_first_round`).

## Verify

- `brouter outcome` on an unknown id fails loud; a second report for the
  same id is an update, not a duplicate row.
- `act wait --merge` on a routed bead writes exactly one outcome row
  (integration test with a fake gh).
- stats with zero rows prints the prior and `n=0`, not a fake rate.
