# bro-2u5 — Versioned plan schemas + bro plan validate

## Problem

Unified plans are declared "the contract" (`bro run <file>` routes a
TOML doc on `kind` to a plugin's `planSchema`), but the schemas are
versioned nowhere. An external producer — a CI job, another agent, a
queue pusher — writes a plan against whatever shape happens to be
installed; when a schema drifts, the failure surfaces at execution
time inside `bro run`, after the payload has already been pushed. There
is also no way to check a plan without executing it: `bro run` is
validate-and-execute in one step, so "is this file right?" requires
running it for real.

## Design

Two parts, one contract surface.

### Schema versions

Each plan kind declares a monotonically increasing schema version —
`PLAN_VERSION = 1` next to `PLAN_KIND` in every plan module, exported
from the package index under the kind-prefixed alias (`ACT_PLAN_VERSION`,
…). The plan envelope gains an optional top-level `version` key:

```toml
kind = "act"
version = 1          # schema the producer wrote against — optional
```

Semantics: `version` is a pin, not a requirement. Absent means
unversioned — every plan in the wild today carries no pin and keeps
working; requiring one would break the contract rather than stabilize
it. When present it must be a positive integer ≤ the kind's current
`PLAN_VERSION` — a pin *newer* than this bro understands is rejected
with the supported version named in the error, never silently
misparsed.

The check lives in one helper in `@broject/core` —
`checkPlanVersion(raw, kind, latest, errors)` — and runs at both
layers, same as `kind` already does:

- **Each `parseXPlan`** allows `version` in its top-level key set and
  calls the helper — direct SDK callers get the same contract, and a
  hand-run `bro retrospect record <file>` doesn't reject the key as
  unknown.
- **The routing layer** (`bro run` / `bro plan validate`) checks
  `doc.version` against the plugin's `planVersion ?? 1` before the
  schema runs — external plugins get the gate uniformly even though
  their schemas predate the convention.

`BroPlugin` gains `planVersion?: number` — the advertised contract;
registry entries source it from the package consts, external plugins
default to 1.

### `bro plan`

New command plugin (`commands/plan.ts`), the contract's discovery and
pre-flight surface:

- `bro plan` — lists every plan kind with its schema version: the
  table an external producer targets.
- `bro plan validate <file.toml>` — runs the full `bro run` pipeline
  (TOML parse → kind routing → version gate → `planSchema`) and stops
  before `runPlan`. Valid prints `ok — <kind> plan, schema v<N>`;
  invalid throws the same aggregate error `bro run` would report,
  exit 1. `validate` must share routing with `bro run` — a validator
  that disagrees with the executor is worse than none — so the
  resolve step is extracted into `resolvePlanDoc(file, plugins)` in
  `commands/plan.ts` and `runPlanFile` in `plugins.ts` calls it.

Non-goals: no version ranges, no migration machinery, no stdin
validation — v1 of the contract is a pin + a gate.

## Plan

- [ ] `core/plan.ts`: `checkPlanVersion` (+ export); `plugin.ts`:
      `planVersion?: number` field + field check
- [ ] `PLAN_VERSION = 1` + `version` key in act, convoy, debt, drill,
      next, retro parsers; package index exports
- [ ] `commands/plan.ts`: `resolvePlanDoc`, `bro plan` list,
      `bro plan validate`; `plugins.ts` routes `run` through it,
      declares `planVersion` per entry, registers `plan`
- [ ] docs: site `plans.md` envelope section + `bro plan`; retro
      `PLAN_SCHEMA` template line; module doc headers
- [ ] tests: per-parser version cases, `commands/plan.test.ts`
      (list/validate/gate), `plugins.test.ts` field check, core
      helper test
- [ ] `npm test` (the CI gate) green
