---
parent: bro-huy5o
---

# bro-pbnsx — provider spend in the fleet events journal

## Problem

Operators can see a local proxy for fleet capacity and provider walls, but
cannot answer “what did bead X spend, and with which provider?” Provider
responses already carry usage on some wires and ACP agents emit
`usage_update`, but those facts are not consistently attached to the durable
per-agent events archive.

## Design

The durable source for agent-level usage is the existing per-agent
`<git-common>/bro/agents/<agentId>.events.jsonl` archive owned by
`@broject/providers`'s `agentTurnPlane` (the same writer that serializes
turn start/stop and every ACP update). This reuses the existing event plane,
rather than inventing a parallel journal. The standalone `@broject/core`
provider spend ledger remains the API provider accounting surface; its
`recordSpend` writer is not replaced by this slice.

### Minimal ledger shape

```ts
interface UsageArchiveRow {
  kind: 'usage'
  ts: string
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  usage: unknown
}
```

For each usage observation, the archive writes an additive `kind: "usage"`
row with ISO wall-clock `ts`, provider/model when known, and finite
non-negative `inputTokens`, `outputTokens`, and `costUsd` only when reported.
The original usage payload is retained. Missing fields remain omitted,
never guessed or emitted as zero. Existing turn start/stop timestamps supply
the wall-clock boundaries. Writes remain fail-open: telemetry cannot fail a
provider response.

The first implementation records one provider response shape only (the
existing judge/provider HTTP usage contract, where `cost_usd` is mapped to
`costUsd`). Other providers and ACP usage events are follow-up work; they
must use this seam rather than create parallel ledgers.

### Surfaces

Later slice 2 (`bro fleet status --json`) will read these archives and
aggregate by bead, provider, model, and UTC time windows (day plus an
operator-selected window), exposing reported token/cost totals and counting
unknown costs. Later slice 3 will show the same aggregate and unknown
markers in `/ui`. Neither surface is implemented here.

## Verify

* Unit tests at the `agentTurnPlane` seam prove a usage update produces one
  usage row with provider/model and reported token/cost fields, while silent
  fields are absent rather than zero or estimated.
* Existing archive tests continue to prove raw updates, ordering, bounded
  writes, and fail-open behavior.
* Run the providers package tests through `scripts/run-tests.ts` after the
  affected package is built.
