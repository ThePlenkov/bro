# @broject/drill

[![npm](https://img.shields.io/npm/v/@broject/drill)](https://www.npmjs.com/package/@broject/drill)

Scoped descent frames behind `bro drill` — `drill down` opens a narrower
investigation frame (materialized as a bead), `drill up` closes it with a
mandatory result + prevention memo so a problem can't silently recur.

> You probably want the CLI instead: `bro drill down --title …`.
> Install this only when building agents that run drill frames.

## Install

```bash
npm i @broject/drill
```

Requires Node ≥ 22 and `bd` (frames are beads). ESM only.

## Surface

- `drillConnector` — registers `bro drill *` subcommands
- `PreventionPlan` — the required close-out artifact
- `parseDrillPlan` / `DRILL_PLAN_KIND` — the unified drill plan payload
- Re-exports `bd`/`taskStore` primitives from `@broject/core`

## Links

- Docs: https://broject.dev/docs/commands/drill
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/drill
- CLI: https://www.npmjs.com/package/@broject/bro
