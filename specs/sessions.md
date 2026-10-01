---
parent: project
---

# sessions — agent lifecycle: hooks, worktrees, drill, loop

## Scope

`bro hooks <event>` — seven lifecycle events (session-start,
post-compaction, pre-compact, prompt-submit, post-tool, stop,
permission): session/prompt probes, post-tool nudges, stop-gate
contributions, and permission auto-approval; session arming
markers; parallel-work detection. `bro work` — linked worktree
lifecycle. `bro drill` — scoped descent frames.
`bro loop` — claim→agent→gate→close automation; `bro next` — claim and
emit a work order.

## Owns

```text
hooks.json  hooks/run.sh
packages/cli/src/commands/{hooks,work,drill,loop,next}.ts
packages/loop/ packages/drill/ packages/convoy/
packages/cli/src/commands/convoy.ts
skills/{work,drill,loop,next,convoy}/
```
