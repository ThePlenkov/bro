---
parent: project
---

# backends — connector/facade seam + task stores + sync

## Scope

The Connector contract: optional capabilities (`tasks`, `reviews`,
`specs` facades + hook probes) a system may implement — GitHub provides
only `reviews`, beads only `tasks`. Beads task store, GitHub/GitLab
review hosts; `bro sync` — the `refs/bro/data` gitref store, CAS push,
tree-union JSONL merge.

## Owns

```text
packages/core/src/connectors.ts      registry, FacadeMap, resolution
packages/core/src/tasks.ts           TaskStore contract + beads store
packages/core/src/dataref.ts         plumbing-only ref writes
packages/github/ packages/gitlab/
packages/cli/src/commands/sync.ts
```
