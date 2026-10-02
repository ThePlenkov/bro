# Agents facade + bro fleet — orchestrator connectors

Parent: `sessions` capability. See `../spec.md`.

## Problem

Detached `devin -p` sessions work (convoys prove it), but supervision is
hand-rolled per session: `pgrep` patterns, `kill -0` watchers, log tails.
Fleet visibility, respawn decisions, and external runtimes (gascity, tmux,
paseo, cao) need one contract — not per-backend shell folklore.

## Model

`agents` facade over orchestrator backends, same shape as `specs` facade:

- `agents.backend` in `bro.config.json`: `native | gascity | tmux | paseo | cao`
  (default `native`; `auto` picks by detected config, e.g. a gascity config
  dir → gascity).
- Connector contract (minimal, capability-declared):
  `spawn(spec) → agentId`, `list()`, `status(id)`, `stop(id)`,
  `capabilities()` (attach/respawn/on-demand-supervisor).
- `agentId` is stable per mol-step — respawning a step's worker keeps the id;
  this is what makes "no duplicate respawn" decidable.
- Beads claim stays the single source of truth across ALL backends: any
  connector's agent claims its step in the shared dolt → `bro fleet` sees it.
- Backend-specific config never leaks up: a connector translates
  `bro.config.json` + molecule into whatever its runtime needs (gascity
  packs, tmux sessions, paseo config). `bro agents up|down` owns the
  supervisor lifecycle; `native` is a no-op supervisor (processes are
  self-sufficient).

## `bro fleet`

Read-only view, works regardless of backend: mols × steps × agents ×
worktrees × PR gates. Phase 1 one-shot table; `--live` TUI later; site
route optional. An agent dead while its step stays claimed renders as
`lost — respawn?` — the respawn decision surface.

## Filetree

```text
packages/core/src/agents.ts        contract + facade
packages/cli/src/agent-connectors.ts  native (+ registry for external)
packages/cli/src/commands/fleet.ts    bro fleet
packages/cli/src/commands/agents.ts   bro agents up/down/status
```

## Milestones

1. `bro-4bkv` spike: is gascity automatable? (CLI surface, generated
   config/packs, on-demand supervisor) — decides whether the gascity
   connector is viable or degenerate.
2. `bro-g4vn` MVP: facade + native connector + `bro fleet` one-shot.
3. Connectors: gascity (if spike green), tmux, paseo, cao.
4. `bro fleet --live` TUI; optional site route.
