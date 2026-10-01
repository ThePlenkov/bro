---
parent: project
---

# sessions — agent lifecycle: hooks, worktrees, drill, loop

## Scope

`bro hooks <event>` — the six lifecycle events fanning out to connector
probes; session arming markers; parallel-work detection. `bro work` —
linked worktree lifecycle. `bro drill` — scoped descent frames.
`bro loop`/`bro next` — claim→agent→gate→close automation.

## Owns

```text
hooks.json  hooks/run.sh
packages/cli/src/commands/{hooks,work,drill,loop,next}.ts
packages/loop/ packages/drill/ packages/convoy/
skills/{work,drill,loop,next}/
```
