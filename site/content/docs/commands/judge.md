---
title: bro judge
description: A calibrated decision judge for agent loops — typed questions in, typed answers with confidence out.
---

The judge answers typed questions (`choice` / `score` / `noul`) over a
compact state and returns typed answers with confidence — sub-second,
priced in fractions of a cent. The resolved chain is a primary backend
plus `judge.fallback` escalation on unanswered questions and
low-confidence answers; providers come from the
[registry](/docs/commands/providers) via `judge.provider`/`judge.model`,
with the legacy `judge.{baseUrl,apiKeyEnv}` + `judge.llm` shape still
accepted (synthesized into anonymous `api` entries, with a deprecation
warning).

| Command | What it does |
| ------- | ------------ |
| `bro judge decide --state <file\|-> --questions <file> [--connector N] [--json]` | One `decide()` over the resolved chain — answers, `decidedBy`, model, latency, usage. The smoke path: exercises the connector regardless of `judge.mode` |
| `bro judge stats [--since ISO] [--json] [--replay]` | The verdict-journal report: agreement matrix (judge action vs recorded outcome), calibration buckets, p50/p95 latency, cost per provider+model |
| `bro judge replay [--pr N…] [--merged-since ISO] [--limit N] [--connector N] [--json]` | Re-judge archived review threads from merged PRs on the live chain, journal replay verdicts with inferred outcomes, print the replay-scoped stats. Idempotent — a replayed subject is never re-judged |

`judge.mode` governs consumers, not explicit invocation: `shadow`
annotates `bro act threads` with a `judge: …` line under each unresolved
row (journaled so `stats` can score judge-vs-outcome agreement);
`off` (default) decides nothing on its own. See
[`judge` config](/docs/configuration#judge).
