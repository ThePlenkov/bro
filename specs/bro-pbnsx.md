---
scope:
  - packages/cli/src/agent-connectors/core.ts
  - packages/cli/src/commands/fleet.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/commands/trace.ts
  - packages/core/src/routing.ts
  - packages/core/src/wall-ledger.ts
---

# bro-pbnsx — fleet cost and quota ledger

## Problem

Operators can see a local proxy for fleet capacity and provider walls, but
cannot answer “what did bead X spend, and with which provider?” The existing
`budgetSnapshot` is deliberately not a monetary ledger: it counts registry
rows, live entries, spawn timestamps, classified deaths, and reset holds.
`providerWallsFor` derives `rate_limited`/`quota` walls from those same
registry records and from the host wall ledger. These are useful quota
signals, not provider-reported spend.

The trace journal is also not a spend ledger. `traceEntry` records tool,
command, paths, and success, and `journalTrace` tags rows with
`BRO_BEAD_ID`/`BRO_AGENT_ID`; it does not currently record token usage or
cost. The OTLP exporter passes through numeric journal fields if present,
but does not create them. Judge verdicts can already carry `costUsd` and
provider usage in `packages/judge`, although that journal is a decision
ledger, not a per-fleet-bead ledger, and its rows do not consistently carry
bead/provider identity.

Therefore the first slice must not invent spend from spawn count or infer a
provider from a model name. It should preserve the existing quota view and
add a single, explicit recording seam at the provider response boundary.

## Design

### Evidence and ownership

1. `budgetSnapshot` remains the source for capacity/quota evidence. Its
   `basis: "local-estimate"` and `limits` are mandatory and must remain in
   `bro fleet status --json` (the current command is `bro fleet --json`).
2. A provider response that reports usage is the only source for monetary or
   token spend. Missing usage remains unknown; it must never be emitted as
   zero.
3. Each recorded usage row carries the immutable join keys available at the
   boundary: bead/step, provider, model, timestamp, and the reported
   `costUsd` and/or token counts. The write is append-only, bounded, and
   uses the same shared-state locking discipline as the trace journals.
4. Provider walls remain derived quota state, not duplicate ledger rows.
   A wall may be shown beside spend, but a wall is not evidence of dollars.

### Minimal ledger shape

```ts
interface SpendRow {
  ts: string
  bead: string
  provider: string
  model?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

interface SpendSummary {
  basis: 'provider-reported'
  rows: number
  unknownCostRows: number
  totalCostUsd?: number
  byBead: Array<{ bead: string; costUsd?: number; rows: number }>
  byProvider: Array<{ provider: string; costUsd?: number; rows: number }>
}
```

`totalCostUsd` and group `costUsd` are omitted when no row in that group
has a reported cost. Token-only rows remain visible through `rows` and are
not converted using a guessed price. The summary is additive to the existing
`budget` object in fleet JSON, so consumers can distinguish local quota
evidence from provider-reported spend.

The first implementation records one provider response shape only (the
existing judge/provider HTTP usage contract, where `cost_usd` is mapped to
`costUsd`). Other providers and ACP usage events are follow-up work; they
must use this seam rather than create parallel ledgers.

### Surfaces

`bro fleet --json` adds `spend: SpendSummary` alongside `budget` and `walls`.
The current text view remains unchanged in this slice. A board/UI consumer
may render `byBead` and `byProvider` when present, while retaining the
`basis` labels and showing unknown cost explicitly.

## Verify

* Existing `budgetSnapshot` and provider-wall tests continue to prove the
  local quota contract, including fail-closed occupancy and reset holds.
* Add provider-boundary tests proving a reported `cost_usd` is recorded with
  its bead/provider identity, a missing cost remains unknown, and malformed
  usage is rejected rather than silently recorded as zero.
* Add ledger aggregation tests for multiple beads/providers and token-only
  rows, including a shared-state concurrent append.
* Add a fleet JSON contract test proving `budget`, `walls`, and `spend` are
  all present and that spend totals are never confused with quota counts.
* Run the affected package build, its tests, and TypeScript typechecking.
