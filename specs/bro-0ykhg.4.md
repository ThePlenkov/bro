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
new UUID `decisionId`, generated once before journaling (not an existing
verdict field and never derived from truncated task text). Add it to the
decision result and journal row, including cache hits and table fallback;
bro pins it on the worker registry entry and bead (`router:decision=<id>`).
The journal persists the task/run identity and intended worker/bead links
before spawn. Pin writes are idempotent; startup and pre-outcome
reconciliation repair missing pins from that journal, rather than guessing
from task text. Old rows lacking an ID are counted as non-joinable, not
silently assigned an outcome.

Each new row also stores replayable task text, carried inputs, candidates,
formula/table snapshots and hashes, judge configuration identity and stage
answers. `contextId` is an explicit stable project namespace (canonical
repository ID when available; standalone callers configure one, otherwise
use the canonical table location). Group outcomes by this namespace plus
table/formula hashes and route ID, not by a route name across projects.

**The router's surface, bro as reporter.** The router runs without beads,
so it never reads act. bro reports:

```text
brouter outcome <decisionId> --result merged|failed|abandoned|parked \
  [--rounds N] [--threads N] [--cost USD] [--tokens N] [--wall-ms N] [--json]
```

(also the library call `recordOutcome()`), invoked by both `bro review act
merge` and `bro review act wait --merge`, by drive/loop reapers on abandon,
and by the fleet on a terminal exit cause. Direct merge obtains the ID
from the routed bead/registry links, reconciled through the journal.
Before a merge attempt or terminal transition, persist an outcome-report
intent with the decision ID and PR/run identity. On success, deliver via a
durable outbox; startup, wait's already-merged path, and reapers reconcile
the actual PR/run state and retry until router acknowledgement. Retrying
the same event is idempotent; never merge again merely to report feedback.

**Evidence, not worker assertions.** `recordOutcome()` accepts a reporter,
event ID, authoritative source identity and source revision. bro's trusted
reporter checks the actual merged PR and act verdict/round count, or the
registry's terminal run record; the router consumes verified reports via
the generic reporter seam, without importing act or requiring beads.
Standalone operators supply a verifier for their outcome authority.
Unverified CLI submissions are stored as pending, excluded from recall,
scoring and invalidation, and cannot replace verified outcomes. Workers
cannot access the reporter credential or verified-store write path: run
them with an isolated identity/filesystem boundary. Same-UID unrestricted
workers are not a security boundary; without isolation independently
reconcile source evidence before trusting reports.

An identical event is a no-op; older revisions from the same source are
ignored. Conflicting terminal reports from unrelated sources are retained
for reconciliation, not last-write-wins. A verified merged PR supersedes
fleet failure/abandon signals for that PR; only a newer verified revision
from the merge authority may correct its measures. Explanations record
provenance and the reason for any rejected update.

**The table.** `outcomes(decision_id PRIMARY KEY, context_id, table_hash,
formula_hash, route, provider, model, task_text, features_json, result,
rounds, threads, cost, tokens, wall_ms, reporter, event_id, source_id,
source_revision, verified, at)` in router.db + an FTS5 index on `task_text`
for T1. Missing measures are NULL (unknown), never 0. Source revisions are
authority-defined monotonic revisions, not lexically compared timestamps.
Reports for unknown decisions fail loud; cost/wall time must be finite and
non-negative, rounds/threads/tokens non-negative integers when present.

Create the state directory owner-only (0700), database and SQLite WAL/SHM
sidecars owner-readable/writable (0600); enforce this for existing stores
or fail with an actionable error on unsupported permissions. Apply the
same privacy rules to journal snapshots, cache and exports. Redact secrets
before persistence; never put credentials in task text. `taskTextRetentionDays`
defaults to 30; expiry atomically removes text, FTS entries, replay snapshots
and derived text-bearing cache values, retaining numeric aggregates only.
An operator can set zero to disable text persistence/recall/replay entirely;
the explanation and replay report count unavailable/redacted rows.

**The read-model.** `P(success | route, features)` is `(s + 1) / (n + 2)`
over verified terminal rows per (context, table/formula hashes, route,
canonical feature bucket) in the last 30 days, with Beta(1,1) prior.
`success` is a validated formula key: `merged` counts every merged row;
`merged_first_round` (default) requires merged and `rounds=1`. Missing
rounds under that predicate are unlabelled and excluded from `n`, not
assumed one. Failed/abandoned/parked terminal rows count as failures.
`brouter stats outcomes [--json]` prints the predicate, window, successes, failures, excluded rows and
`n`; scoring, T1 voting, replay labels and invalidation use the same
predicate evaluator. Zero rows yield 0.5 with `n=0`, never a judge score.

## Verify

- Repeated task text produces distinct IDs; result, journal, worker, bead
  and outcome agree on each ID; crash between pin writes is repairable.
- Unknown IDs, invalid measures and forged/unverified reports cannot
  affect stats. Duplicate delivery is a no-op; stale or conflicting events
  cannot overwrite an authoritative merge.
- Direct merge, wait merge, already-merged reconciliation, abandon and
  fleet terminal paths report; crash after merge before acknowledgement
  is retried into exactly one outcome row (integration tests with fake gh).
- Text redaction, zero/expired retention and directory/DB/sidecar permissions
  cover both new and existing stores; expired text is absent from FTS/cache.
- Changing `success` changes labels, stats and cache invalidation consistently;
  missing rounds are excluded only when the predicate requires them.
- stats with zero rows prints the prior and `n=0`, not a fake rate.

## Implementation delta (this PR)

Assumptions re-checked against the tree; where the build diverged from
the text above, this is the contract that shipped:

- **Context resolution order** (`decisionContextId` in
  `packages/brouter/src/context.ts`): canonical `projectId(dir)` →
  configured `brouter.contextId` → `table:<sha256-16 of the canonical
  route-table path>` → `dir:<sha256-16 of the canonical dir>`. The last
  fallback covers standalone callers with no table at all. Reads resolve
  the table path exactly as `brouter route` did — `brouter stats
  outcomes` accepts the same `--routes` flag and reads the same
  `brouter.routes` config, so a flag-override decision and its stats
  share one namespace; `--context` overrides everything.
- **CLI surface beyond the sketch**: `brouter outcome` also takes
  `--event`, `--token`, `--path`; `brouter stats outcomes` takes
  `--context`, `--route`, `--success`, `--days`, `--table-hash`,
  `--formula-hash`, `--path`, `--json`. A bare CLI submission is pending
  unless it presents the store's reporter credential (`--token` or
  `BRO_ROUTER_REPORTER_TOKEN`); the credential lives beside the ledger
  at mode 0600 inside the 0700 state dir.
- **Durable outbox**: intents persist to
  `<git-common>/bro/outcomes/outbox.jsonl` before delivery; `delivered`
  markers make retries exact. The event id is a content hash, so a
  retried verdict is the same event. `reconcileOutcomes()` runs at
  `act wait`/`act merge`/`loop` startup and rides the same pass as the
  `taskTextRetentionDays` expiry sweep.
- **Monotonic source revisions**: bro's reporter computes
  `max(Date.now(), highest recorded revision for the source + 1)` from
  the store's own `outcome_reports` audit log — `Date.now()` alone
  collides inside one millisecond and the store's `<=` staleness rule
  would drop same-ms batch reports.
- **Who reports what**: `act merge`/`act wait --merge` report `merged`
  (rounds = `fixRounds + 1`, threads = total review threads — act's
  round count, so a clean first-round merge reports `rounds=1`, the
  `merged_first_round` success shape); closed-unmerged PRs report
  `failed` via the same path. Loop claim settlement reports `failed`
  and `parked`; fleet terminal exits flow through that same settlement.
  Merge authority owns `merged`; loop deliberately never reports it.
- **Non-joinable old rows**: `decisions` is a new table — there are no
  pre-id journal rows to count; every current row carries a UUID, and
  `outcome_reports` preserves the audit trail (including rejected
  reports with reasons) for the explanation surface.
- **Stats read-model shape**: `outcomeStats(db, {contextId, route?,
  tableHash?, formulaHash?, features?, featureKeys?, success?, since?,
  now?})` returns `{p, n, successes, failures, excluded, costUsd,
  wallSec}`; `labelOutcome()` is the single predicate evaluator
  (`merged` / `merged_first_round`) shared by stats, recall gating and
  the .7 `OutcomeStatsSource` adapter. Verified-only rows count;
  pending rows surface via `pendingOutcomeCount()`.
