# @broject/query

[![npm](https://img.shields.io/npm/v/@broject/query)](https://www.npmjs.com/package/@broject/query)

The `kind = "query"` plan runtime behind `bro query` — cross-provider
GraphQL fan-out over bro connectors (github/gitlab/atlassian) under a
concurrency cap, one merged JSON document keyed by step id.

> You probably want the CLI instead: `bro query <plan.toml>` or
> `bro run` on a `kind = "query"` plan. Install this only when embedding
> query plans in your own runner.

## Install

```bash
npm i @broject/query
```

Requires Node ≥ 22. ESM only.

## Surface

- Query plan schema + validation — read-only documents only; `mutation`/`subscription` rejected
- The fan-out executor — per-step connector spawns, failures recorded, never aborting siblings
- `connectors.queries` pin + auto-detection shared with `bro run`

## Links

- Docs: https://broject.dev/docs/commands/query
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/query
- CLI: https://www.npmjs.com/package/@broject/bro
