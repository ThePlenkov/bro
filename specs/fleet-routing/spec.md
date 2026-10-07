---
parent: project
---

# fleet-routing — context/quota-aware dispatch across providers

## Scope

The dispatch arbiter: which configured provider runs a unit of work,
and what happens when the chosen provider walls. Extends the provider
registry (specs/bro-ribc.1.md), the fleet spawn surface
(specs/bro-5hx1.1.md), and the exit-cause taxonomy
(specs/bro-7xgk.2.md) — those make a spawn attributable and a death
classifiable; this area makes the *choice* a routing decision and the
*aftermath* a re-dispatch.

Also owns the two orchestration rules the arbiter presupposes:
**watchers are finite** (a bounded watch or a per-task wait that exits
on its event — the exit IS the wake) and **sessions continue** (a
completed unit feeds the next work order back into the same session
through the mailbox; `bro convoy run` is explicit parallel fan-out,
not the default loop). Design: specs/fleet-routing/bro-1x7p.md.

## Owns

```text
packages/core/src/routing.ts          class → chain resolution, provider-wall derivation
packages/core/src/config.ts           fleet.routing section
packages/cli/src/agent-connectors.ts  chain walk on spawn/respawn (provider-scoped blocks)
packages/cli/src/commands/convoy*.ts  done → mailbox emission
packages/providers/src/acp-worker.ts  session/load resume
skills/{convoy,next,work}/            continuation text
```

## Related

- bro-4sn6 — the fleet-routing epic this spec serves.
- specs/sessions/spec.md — agents facade, fleet cap, spawn facade the
  arbiter routes through.
- specs/judgments/spec.md — the shadow→advisory→enforce ladder the
  optional judge router rides.
