# brouter bench — classifier replay

journal: `/home/pepl/.local/state/brouter/router.db` · window all time → 2026-11-12T07:39:38.152Z
decisions: 2 journaled · 2 replayable · skipped none
outcomes: success=0, failure=0, unlabelled=0, unverified=0, none=2 · verified results none
invoke=ambiguous · ambiguous-gate skips 1/2

| contender   | kind  | agreement                                                                                                                       | labelled | p50 ms | p95 ms | cost/1k | skipped | failed |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | ------- | ------- | ------ |
| systemone ⚠ | model | failed — the env var named by providers.systemone.apiKeyEnv is not set — export a TypeSafe API key (<https://docs.typesafe.ai>) | 0        | —      | —      | $0.0000 | 1       | 1      |

agreement = historical agreement over verified-success outcomes — not routing accuracy

- historical agreement compares picks to the route that historically executed — it is agreement, not routing accuracy; the observed route is not a counterfactual oracle and an untried route is unknown, never incorrect
- agreement counts verified successful outcomes under each decision’s own success predicate only; failed/abandoned/parked rows carry no agreement target, unlabelled and unverified rows are excluded and counted
- calibration requires a paired-run dataset with measured outcomes per compared route (bro-l8c4f.9) — not measured here
- T1 recall is frozen to outcome rows accepted before each decision, its own outcome excluded — recall cannot retrieve its test label
- replay writes nothing to router.db — no journal rows, no cache entries, no outcome reports
