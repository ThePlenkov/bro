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
  complexity: { type: choice, options: [low, medium, high] }
  mode:       { type: choice, options: [planning, coding, review, fix] }
  needs_ui:   { type: bool }
filters:                   # hard, evaluated by code — the model cannot override
  - route: free-lane
    unless: { complexity: [high] }
success: merged_first_round # merged | merged_first_round; default shown
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
  highest wins, ties keep table order. `P` is the posterior mean from
  outcomes (bro-0ykhg.4), including the Beta(1,1) prior mean 0.5 at `n=0`;
  a judge score is not a calibrated success probability. Only this shape
  accepts `score: { lambda: 0.3, mu: 0.1 }` (finite non-negative weights).
  `cost` is mean task cost in USD and `latency` mean task wall time in
  seconds from verified terminal outcomes in the same routing context and
  feature bucket, over the last 30 days. They are not the existing request
  or token counters. Missing or incomplete measurements make that measure
  unknown. If any candidate has
  an unknown measure with a positive weight, skip scoring for the entire
  candidate set and retain table order with an explicit explanation. A zero
  weight needs no measure; unknown cost remains unknown, never zero.

The route schema and resolver grow a `features` namespace in task input
and `match`: `match.features.mode: [coding]`, for example. Keys must name
declared questions; categorical matches require `choice` or `bool`
questions with correctly typed values. Numeric `score` questions cannot
drive categorical matches (no implicit conversion to levels). Existing
`type`, `complexity`, and `priority` matches remain compatible; the example
declares `complexity` as a choice with those existing values. Conflicting
caller and inferred values fail validation rather than silently overriding
one another.

`filters` are code-owned and apply before every chain dispatch, including
T0/T1 decisions, cache hits, and table-order fallback. `unless` removes the
named route when its predicate matches. Unresolved filter inputs are not
permission to dispatch: obtain the answers under bro-0ykhg.2 or exclude
the affected route. Filters cannot add candidates or override health.
These are guarantees relative to supplied answers, not a claim that a
judge can never misclassify; deterministic restrictions use trusted inputs.

Validation (`brouter routes validate` grows a formula check): every
question referenced by `match`/`filters` must be declared; choice `options`
non-empty and unique; `score` keys only under `shape: score`;
`success: merged | merged_first_round` is allowed for every shape and
defaults to `merged_first_round`; labels/paths/repo matches use .2's typed
task fields; unknown keys are errors
(invalid input fails loud). The schema lives in `@broject/router-routes`.

## Verify

- Schema tests: each shape round-trips; a filter naming an undeclared
  question, a `score` block under `shape: features`, empty `options`, a
  numeric question used as a categorical match, an invalid success value — each
  is a named problem.
- Resolver tests with a fake judge: `features` answers drive `match`; a
  filter removes a candidate the judge preferred; `score` ranks by the
  formula; unknown positively weighted measures preserve table order, not
  a free score. Zero-row probability is 0.5; measured costs and latency use
  USD and seconds. Declared feature keys work; undeclared keys fail loud.
- `brouter route "<task>" --formula f.md --explain` prints the answers, the
  filters that fired, and the score per candidate.
