---
title: bro query
description: Cross-provider GraphQL fan-out — one plan, many connectors, one merged JSON answer.
---

A `kind = "query"` [plan](/docs/plans) is a TOML list of independent
GraphQL steps. `bro run` fans them out over connectors under a
concurrency cap and prints one merged JSON document keyed by step `id` —
declaration order, never completion order.

| Command | What it does |
| ------- | ------------ |
| `bro query <plan.toml>` | Validate + run a query plan in one step — raw JSON on stdout, exit 1 when any step failed |
| `bro run <plan.toml>` | The same plan through the generic runner (`kind` routes it) |
| `bro plan validate <file>` | Check the plan without executing it |

## The contract

- `provider` names a **connector** (the data plane: `github`, `gitlab`,
  `atlassian`, …) — never a [`providers`](/docs/commands/providers)
  entry; that registry is the *model* plane. Absent →
  `connectors.queries` pin → auto-detect.
- **Read-only.** `mutation`/`subscription` documents are rejected at
  validate time.
- **No secrets in plans.** `env` is a *literal* overlay — a token value
  written there is committed as text. Auth comes from the spawned CLI's
  own login (`gh auth`, `glab auth`, `atlassian auth`) or the operator's
  inherited environment; execution-shaping vars are rejected outright.
  Operators pin endpoints via the [`query.env`](/docs/configuration#query)
  config section instead.
- `vars` are scalars (string/number/bool) for `github`/`gitlab` —
  serialized as `-f k=v` CLI fields. `atlassian` takes the table as the
  JSON `variables` body verbatim.
- A failed step records `{ provider, error }` (transport) or
  `{ provider, data?, errors? }` (GraphQL response) and never aborts
  siblings. Any failure → exit 1; results still print.
- Output is raw — no item normalization.
