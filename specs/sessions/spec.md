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
emit a work order. `bro agents` + `bro fleet` — orchestrator facade
(backend connectors: native/gascity/tmux/paseo/cao) and the read-only
fleet view; `bro serve` — facade host for thin clients.
Session planes — host-wide admission quotas per session kind
(`agents.<kind>.maxSessions` for all sessions, `agents.<kind>.maxWorkers`
for the spawned subset): core owns the abstract registry, the
TTL reservation lifecycle, and the serialized admit under one host
mutex; each vendor plane (`packages/cli/src/session-planes/`)
registers itself and owns only how its live sessions are detected and
counted. Vendor names never reach core.

## Owns

```text
hooks.json  hooks/run.sh
packages/cli/src/commands/{hooks,work,drill,loop,next,convoy}.ts
packages/cli/src/commands/{agents,fleet,serve}.ts
packages/core/src/agents.ts  packages/cli/src/agent-connectors.ts
packages/core/src/session-planes.ts  packages/cli/src/session-planes/
packages/loop/ packages/drill/ packages/convoy/
skills/{work,drill,loop,next,convoy}/
```
