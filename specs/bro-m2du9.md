# bro-m2du9 — session pane shows the true agent provider

## Problem

Every `bro: session` pane reports its display agent as the readable
run id (`bro-2bv6q`) — the registry KEY `agentKey` resolves from the
archive stem. A human reading a pane row sees a bead slug, not the
agent that is actually running: `opencode-iceman`, `devin`,
`devin-acp`, `omp-minimax`, … — the name the in-render turn labels
already print.

## Contract

`displayAgentOf(base, id)` in `packages/herdr-kit/src/client/registry.ts`
resolves the display name with the same lookup contract as
`agentEntry`/`agentKey` (registry key first, then log-stem match):

1. `entry.provider` — the true agent name — wins.
2. The readable run id (`agentKey`) falls back when the spawn carried
   no provider.
3. The raw argv id is the last resort — the archive stem
   (`native-<hash>`) is never the surface.

`tui/main.ts` swaps its inline `agentKey ?? agentArg` pick for the kit
helper — one resolution path, unit-testable.

## Verify

- `displayAgentOf` over a fixture registry: provider wins over the
  run id; a provider-less entry falls back to the run id; an unknown
  id returns the argv stem.
- Typecheck `@broject/herdr-kit` and the plugin.
