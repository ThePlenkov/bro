---

parent: bro-6ptci
scope:
- packages/core/src/plugin.ts
- packages/cli/src/commands/act.ts
- packages/cli/src/commands/next.ts
- packages/cli/src/commands/rig-next.ts
- packages/cli/src/commands/rig.ts
- packages/cli/src/commands/fleet.ts
- packages/cli/src/commands/status.ts
- packages/cli/src/commands/agents.ts
- packages/cli/src/plugins.ts
- packages/cli/schemas/cli/**
- contract/cli.json

---

# bro-pbfdp — JSON Schemas for --json outputs of agent-facing read commands

Parent: `bro-6ptci` (epic — the CLI is the agent contract). Unblocks nothing directly except making agent parsing stable; the schema refs are what `bro contract dump` already reserves.

## Problem

Agents parse `--json` from `act status` / `fleet status` / `rig next` / `flow next`, but the shapes are only TypeScript types; a field rename silently breaks every skill and thin client. `CliSubContract.json` exists to point at `schemas/cli/<name>.json` but there are no schema files and the contracts don't reference them.

## Design

### Schema files

Put JSON Schemas under `packages/cli/schemas/cli/` (mirroring `bro.config.schema.json` location style). One schema per agent-facing read command's `--json` output. Start with the four called out: `act-status.schema.json`, `fleet-status.schema.json` (or cover `fleet` and `status`), `rig-next.schema.json`, `flow-next.schema.json` (or `next.schema.json`).

Schemas must be strict enough to catch renames: use `additionalProperties: false` where practical, document required fields, use proper types. Match actual output shapes exactly as emitted.

### Contract wiring

Add `json: "schemas/cli/....schema.json"` (or relative path as the contract expects) to the relevant `contract` blocks in `plugins.ts` and ensure `contract/cli.json` reflects them after regeneration.

### Shapes to capture

- `act status --json`: currently emits `{ pr: state, exit_gate: gate }` (see act.ts). Schema must match `PrActState` + `ExitGate` shape as serialized.
- `fleet` / `fleet status` (status command): `fleet` with `--json` emits `{ rows, degraded, conflicts, prErrors, occupancy, budget, walls, wallsError }`. `status` (`fleet status`) with `--json` emits board JSON — need to capture its actual shape.
- `rig next --json`: emits `RigNext` `{ verdict, id?, detail? }`
- `flow next --json` (`next`): emits `NextResult` `{ state, bead?, beads, queue, filtered, foreign, gates, epics, moleculeSteps }` with `ReadyBead` shape.

### Generation/validation

Add schemas to be validated by contract tooling if needed. Ensure `npm run check:contract` still passes.

## Plan

- [ ] Create specs/bro-pbfdp.md (this file)
- [ ] Create `packages/cli/schemas/cli/` directory and JSON Schema files for the four agent-facing read commands
- [ ] Wire `json` schema refs into contracts (plugins.ts and/or ensure contract/cli.json gets updated)
- [ ] Verify schemas match actual outputs
- [ ] Run tests/checks as appropriate

## Verify

- Schemas exist and are valid JSON Schema
- `contract/cli.json` references them where appropriate
- `npm run check:contract` passes
- Outputs conform to schemas (spot check)
