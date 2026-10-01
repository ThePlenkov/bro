---
parent: project
---

# sdd — spec-driven development policy + specs facade

## Scope

`sdd.mode` (off|remind|gate) policy, the `specs` facade over the
project's own SDD tool (native specs/, speckit, openspec, agent),
`bro spec check|new|tree|init`, and the sddConnector hook probes that
nudge and gate on own-claims.

## Owns

```text
packages/core/src/specs.ts            SpecStore facade contract
packages/cli/src/spec-connectors.ts   native/speckit/openspec/agent
packages/cli/src/commands/spec.ts     commands + sddConnector
skills/sdd/
```
