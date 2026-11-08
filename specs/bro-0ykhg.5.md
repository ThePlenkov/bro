# bro-0ykhg.5 — brouter classifier bench: replay the journal across judge models

Child of bro-0ykhg (specs/bro-0ykhg.md). Depends on bro-0ykhg.4 (outcome
rows are the oracle). Extends `@broject/judge` replay/stats.

## Problem

Jev is wired as the typed-grade judge, but nothing says it routes better
than the static table, a router-specialized small model, or a cheap hosted
one — on this repo's tasks, at this repo's latency and cost.

## Design

`brouter bench replay [--since] [--judges a,b,c] [--json]` re-asks each
journaled decision (task text + the candidate set it had) with every listed
judge, offline, and scores the answers against the outcome oracle: the
route whose outcome row merged first-round (rows without an outcome drop
out and are counted).

Contenders (each is a provider entry, nothing hard-wired):

| contender               | how it runs                               | why                                   |
| ----------------------- | ----------------------------------------- | ------------------------------------- |
| static table            | T0 only, no model                         | the baseline every model must beat    |
| T1 recall               | FTS5 top-k over outcomes                  | the free contender                    |
| Jev (System One)        | `systemone` connector, typed answers      | typed + calibrated by design          |
| Arch-Router 1.5B        | local, llama.cpp / ollama                 | trained for task → route-by-description |
| small open model        | Qwen3 0.6–4B / Gemma small, local, grammar-constrained JSON | free, local |
| cheap hosted            | a Flash-Lite / nano / Haiku-class lane    | latency / price reference             |

Metrics per contender: agreement with the oracle, calibration (reliability
buckets — `judge stats` already has them), p50/p95 latency, cost per 1k
decisions (`unknown` stays unknown), share of decisions skipped by
`invoke = ambiguous`. Prices are read from the provider entries at run time,
never written into this spec.

Output: JSON + a markdown table under `.evidence/brouter-bench/`; the
report states the journal window and row counts.

## Verify

- Fixture journal + fixture outcomes: the replay output is deterministic
  with fake judges; rows without outcome are excluded and counted.
- A contender that errors is reported as failed, never as 0% accuracy.
