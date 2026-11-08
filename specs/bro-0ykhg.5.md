# bro-0ykhg.5 — brouter classifier bench: replay the journal across judge models

Child of bro-0ykhg (specs/bro-0ykhg.md). Depends on bro-0ykhg.4 (outcome
rows supply historical labels). Extends `@broject/judge` replay/stats.

## Problem

Jev is wired as the typed-grade judge, but nothing says it routes better
than the static table, a router-specialized small model, or a cheap hosted
one — on this repo's tasks, at this repo's latency and cost.

## Design

`brouter bench replay [--since] [--judges a,b,c] [--json]` re-asks each
journaled decision (task text + the candidate set it had) with every listed
contender, offline, using the snapshots and stable decision IDs introduced
in .4 (not the old 80-character `subject`). Legacy, redacted, expired or
incomplete replay state is skipped with separate counts and reasons.
Model re-asks may use configured providers, but replay never dispatches
workers or mutates production routing state.

The observed route is not a counterfactual oracle. Report agreement with
the historically executed route only for verified successful outcomes
under the configured success predicate; label it historical agreement,
not routing accuracy or proof that an untried route would fail. Failed,
abandoned and parked rows are reported separately without an agreement
target; unlabelled outcomes are excluded and counted. Outcome-quality and
calibration claims require a separately pinned paired-run dataset with
measured outcomes for each compared route on the same tasks, revisions
and repeats (bro-l8c4f.9). Untried alternatives are unknown, never incorrect.
Freeze each replay's recall/scoring data to rows available before that
decision, excluding its own outcome, so T1 cannot retrieve its test label.

Contenders: `static table` and `T1 recall` are built-in code-stage adapters;
model contenders reference user-configured provider entries, never
hard-wired model integrations. `--judges` selects IDs from both kinds.

| contender               | how it runs                                                 | why                                     |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------- |
| static table            | T0 only, no model                                           | the baseline every model must beat      |
| T1 recall               | FTS5 top-k over outcomes                                    | the free contender                      |
| Jev (System One)        | `systemone` connector, typed answers                        | typed + calibrated by design            |
| Arch-Router 1.5B        | local, llama.cpp / ollama                                   | trained for task → route-by-description |
| small open model        | Qwen3 0.6–4B / Gemma small, local, grammar-constrained JSON | free, local                             |
| cheap hosted            | a Flash-Lite / nano / Haiku-class lane                      | latency / price reference               |

Metrics per contender: historical agreement (labelled denominator),
calibration only with the paired outcome evidence above, p50/p95 latency, cost per 1k
decisions (`unknown` stays unknown), share of decisions skipped by
`invoke = ambiguous`. Prices are read from the provider entries at run time,
never written into this spec.

Output: JSON + a markdown table under `.evidence/brouter-bench/`; the
report states the journal window and row counts.

## Verify

- Fixture journal + fixture outcomes: the replay output is deterministic
  with fake judges and built-in contenders; missing replay state and
  unlabelled outcomes are excluded and counted by reason. Failed outcomes
  have no agreement target; untried routes are not marked wrong. A paired
  fixture is required for any outcome-quality/calibration metric.
- A contender that errors is reported as failed, never as 0% accuracy.
