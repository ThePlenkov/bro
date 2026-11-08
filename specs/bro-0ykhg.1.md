# bro-0ykhg.1 — brouter formula: the MD routing formula — typed questions, scoring weights, hard filters

Child of bro-0ykhg (specs/bro-0ykhg.md). Generalizes the route table's
`prompt` (bro-olfvd.1 S2) and bro-v0pvd.1's complexity × mode matrix.

## Problem

The route table says WHERE a task may land; the only AI step says WHICH
route by reading prose. A user who wants "classify complexity and mode,
then let a matrix decide" (bro-v0pvd.1) or "prefer the cheapest lane that
usually merges first time" has to write code. The md beside the table is
prose with no machine part.

## Design

A formula is one md file: **frontmatter is the contract, the body is the
prose the decision model reads.** `brouter.formula` in bro.config.json (or
`--formula`) points at it; the route table stays the table of lanes.

```md
---
kind: formula
version: 1
shape: features            # features | pick | score
questions:
  complexity: { type: score, levels: [low, medium, high] }
  mode:       { type: choice, options: [planning, coding, review, fix] }
  needs_ui:   { type: bool }
filters:                   # hard, evaluated by code — the model cannot override
  - route: free-lane
    unless: { complexity: [high] }
score:                     # shape: score only
  lambda: 0.3              # weight of cost
  mu: 0.1                  # weight of latency
---
Complexity is HIGH when the task touches more than one package or a
protocol boundary. Review means the task text names a PR …
```

Three shapes, one file format:

- **`features`** — the judge answers the typed `questions` (one call, the
  facade already takes an array); the route table's `match` reads the
  answers as if the task carried them. The matrix of bro-v0pvd.1 is this
  shape with two questions. Explainable: `--explain=route` shows each
  answer and its probability, then the match.
- **`pick`** — today's `routePick`: one `choice` over the candidate routes,
  the body is the shared prose, each route's `description` its criterion.
  The default when no formula is declared — no behavior change.
- **`score`** — each surviving candidate gets
  `score(r) = P(success | r, features) − λ·cost(r) − μ·latency(r)`;
  highest wins. `P` comes from outcomes (bro-0ykhg.4); with no outcome rows
  for a route the prior is the judge's own answer to a `score` question, and
  the explanation says which. `cost` / `latency` come from the ledger's
  window counters — `unknown` cost excludes the route from the λ term and is
  printed as unknown, never treated as free.

`filters` run after the judge and before the chain: a filter can only REMOVE
candidates. A low-ceiling lane never receives a high task even when the
judge is wrong — the bro-v0pvd.1 acceptance, made declarative.

Validation (`brouter routes validate` grows a formula check): every
`questions` key referenced by `match`/`filters`; `levels`/`options` non-empty
and unique; `score` keys only under `shape: score`; unknown keys are errors
(invalid input fails loud). The schema lives in `@broject/router-routes`.

## Verify

- Schema tests: each shape round-trips; a filter naming an undeclared
  question, a `score` block under `shape: features`, an empty `levels` — each
  is a named problem.
- Resolver tests with a fake judge: `features` answers drive `match`; a
  filter removes a candidate the judge preferred; `score` ranks by the
  formula and an unknown-cost route is ranked without the λ term.
- `brouter route "<task>" --formula f.md --explain` prints the answers, the
  filters that fired, and the score per candidate.
