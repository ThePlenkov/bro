# bro-0ykhg.7 — brouter outcomes wiring: OutcomeStatsSource over the .4 outcomes read-model

Child of bro-0ykhg (specs/bro-0ykhg.md). Wires the seam bro-0ykhg.1
landed (`OutcomeStatsSource` in `packages/router-routes/src/score.ts`)
to the read-model bro-0ykhg.4 landed (`outcomeStats` in
`packages/router-store/src/outcomes.ts`). Until now every `shape: score`
decision scored against `priorOnlyOutcomes` — p = 0.5 at n = 0 with
unknown measures — so positive λ/μ weights skipped scoring by design.

## Problem

The score shape's arithmetic exists and its store exists, but nothing
connects them: `decideByFormula` defaults `input.outcomes` to
`priorOnlyOutcomes`, and no caller passes a real source. A score formula
can never rank on live outcome stats.

## Design

**The adapter** — `routerOutcomeStats()` in
`packages/brouter/src/outcome-stats.ts` — builds an
`OutcomeStatsSource` bound to ONE decision's namespace:

- `contextId` — `decisionContextId(dir, { tablePath })`, the same
  resolution `journalDecision` uses, so reads and writes share one
  namespace.
- `tableHash` — `contentHash(table)`; `formulaHash` —
  `textHash(formulaText)`, the same digests the decision journal
  writes. The formula's raw file bytes are required: without them the
  namespace cannot be computed and the source degrades to the prior
  (a decision journaled without formula text can never join anyway).
- window — the read-model's own 30 days (`OUTCOME_WINDOW_MS`).
- predicate — `formula.success`, per call.

`statsFor` is synchronous by contract (score.ts: "a scoring pass never
awaits IO it does not need"), while `outcomeStats` is async over
drizzle. The adapter therefore fetches ONCE at construction —
`outcomeStatsRows(db, { contextId, tableHash, formulaHash, since })`,
verified rows inside the window, every route and feature bucket — then
closes the store and reduces synchronously per candidate. To keep ONE
implementation of the read-model math, `outcomes.ts` splits
`outcomeStats` into `outcomeStatsRows` (the SQL scope: context,
verified, window, route/table/formula hashes) and `reduceOutcomeStats`
(the JS half: route filter, canonical feature bucket, the shared
`labelOutcome` predicate, the means). `outcomeStats` is now
fetch + reduce — identical results, and the .7 adapter reuses the same
reduce per `statsFor` call. No score math, Beta read-model, or formula
contract changes.

Per `statsFor(route, features, formula, table)` call the adapter
reduces with `route.name`, the passed `features`, `featureKeys =
Object.keys(formula.questions)` (the .4 contract: "the .7 adapter
passes the formula's declared question keys"), and
`formula.success`. `OutcomeStats.costUsd`/`wallSec` NULL map to absent
— unknown stays unknown, never zero.

Every failure mode degrades to `priorOnlyOutcomes`, never throws and
never blocks the decision: store unopenable, unmigrated, query error,
missing formula text. That is exactly today's behavior — the prior at
n = 0 — so a broken ledger costs the ranking, not the route.

**The wiring** — `decideRoute` builds the source only when a formula is
declared AND `formula.shape === 'score'` AND no `outcomes` test seam
was passed, then hands it to `decideByFormula`. Other shapes never pay
the store open.

**The journaled bucket.** For the stats join to exist at all, the
outcome row's `features_json` must share the namespace `statsFor`
buckets by — the effective features the formula decided with
(`task.features` merged with the trusted answers under `enforce`;
`task.features` alone under `shadow`/`off`). .4 deliberately kept
answer-derived features out of `features_json` ("volatile model
output"); .7 reverses that for formula decisions only, because the
score shape's whole contract is P(success | route, features) over the
same feature map — once journaled, the answers ARE the stable
historical fact the stats group by. `FormulaTaskDecision` therefore
carries `features` — the effective map — and `decideRoute` journals it
for formula decisions. Formula-less decisions keep the .4 behavior
(`input.features` ?? the task record) byte-for-byte. Under a declared
formula the effective map supersedes `input.features`: `statsFor` never
sees that param, so journaling it would break the join it exists for.

Non-question feature keys ride along in `features_json` but the
bucket's `featureKeys` picks only the formula's declared questions on
both sides — consistent by construction.

## Verify

- statsFor mapping: contextId/table/formula hashes, route, question-key
  feature bucket, 30-day window, `formula.success` — a seeded verified
  outcome lands in p/n/costUsd/wallSec; NULL measures stay absent.
- Isolation: other contexts, other table/formula hashes, other routes,
  other feature buckets, and rows outside the window never count.
- Degradation: empty scope, expired rows (`at` older than the window),
  and zero-retention rows (`features_json` NULL) yield the prior for a
  featured bucket; unverified/pending rows never reach statsFor.
- `decideRoute` integration: a score formula over a seeded store picks
  the route with the better verified p — `picked: 'formula'` — where
  table order alone would not.
- Live smoke: seed router.db outcomes, `brouter route --formula
  score.md --json` ranks by real p/n on the built CLI.
