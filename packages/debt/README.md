# @broject/debt

[![npm](https://img.shields.io/npm/v/@broject/debt)](https://www.npmjs.com/package/@broject/debt)

The review-debt pipeline behind `bro debt` — harvest unresolved review
threads on merged PRs into a local ledger, label PRs `debt:*` so nothing
is scanned twice, and sync open findings into beads.

> You probably want the CLI instead: `npx @broject/bro debt collect`.
> Install this only when embedding the pipeline in your own tooling.

## Install

```bash
npm i @broject/debt
```

Requires Node ≥ 22, authenticated `gh`, and a beads or jsonl store.
ESM only.

## Surface

- `collectPr` / `classifyThread` — per-PR thread harvest + classification
- `fingerprint` / `deriveArea` / `bodyPreview` — stable finding identity
- `HarvestPrFilters` — merged-PR scan filters
- `DebtPrState` — `debt:collected` / `debt:clean` label management
- `syncDebtToBeads` / `listDebtBeads` — ledger → bd projection
- `parseDebtPlan` / `DEBT_PLAN_KIND` — the unified debt plan payload
- `buildTrend` / `TrendOptions` / `TrendPoint` — debt history over time

## Links

- Docs: <https://broject.dev/docs/commands/debt>
- Source: <https://github.com/ThePlenkov/bro/tree/main/packages/debt>
- CLI: <https://www.npmjs.com/package/@broject/bro>
