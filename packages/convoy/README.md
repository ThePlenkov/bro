# @broject/convoy

[![npm](https://img.shields.io/npm/v/@broject/convoy)](https://www.npmjs.com/package/@broject/convoy)

The molecule runner behind `bro convoy` — pours a beads formula into a
runnable molecule (a DAG of steps) and schedules it inside the agent:
`convoy next` emits the next step, `convoy done` advances the graph.

> You probably want the CLI instead: `bro convoy next`.
> Install this only when orchestrating bead workflows programmatically.

## Install

```bash
npm i @broject/convoy
```

Requires Node ≥ 22 and `bd`. ESM only.

## Surface

- `pourFormula` / `resolveMolecule` / `loadMolecule` / `listMolecules`
- `nextStep` / `claimStep` / `stepsOf` / `stepKind` / `stepInputs` —
  DAG scheduling
- `parseConvoyPlan` / `PLAN_KIND` / `GATE_POLICIES` — the unified convoy
  plan payload

## Links

- Docs: https://broject.dev/docs
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/convoy
- CLI: https://www.npmjs.com/package/@broject/bro
