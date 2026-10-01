---
parent: project
---

# plans — versioned plan schemas

## Scope

Unified plans: `bro run <file>` routes TOML plans by `kind` to the
owning plugin's runPlan; `version = N` pins the schema contract;
`bro plan` advertises. Plans make agent orchestration data, not prose.

## Owns

```text
packages/core/src/plan.ts            version check + kind extraction
packages/cli (resolvePlanDoc)        kind → owning plugin routing
packages/*/src/plan.ts,              per-plugin schemas + runners;
packages/cli/src/commands/*plan*.ts  incl. next-plan.ts/parseNextPlan
```
