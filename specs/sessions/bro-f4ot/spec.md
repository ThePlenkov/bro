# Agents facade + bro fleet — orchestrator connectors

Parent: `sessions` capability. See `../spec.md`.

## Problem

Detached `devin -p` sessions work (convoys prove it), but supervision is
hand-rolled per session: `pgrep` patterns, `kill -0` watchers, log tails.
Fleet visibility, respawn decisions, and external runtimes (gascity, tmux,
paseo, cao) need one contract — not per-backend shell folklore.

## Terms

- **mol-step** — a molecule's child bead (convoy step). The unit an agent
  claims.
- **shared dolt** — the repo's beads store (`.beads/` dolt DB, synced via
  `refs/dolt/data`). `.beads/` is stealth — not committed — but the store
  is the coordination plane every backend MUST claim into.
- **agent** — one running worker bound to a claimed mol-step.

## Model

`agents` facade over orchestrator backends, same shape as `specs` facade:

- `agents.backend` in `bro.config.json`:
  `native | gascity | tmux | paseo | cao | auto` (default `native`; `auto`
  picks by detected config, e.g. a gascity config dir → gascity).
- **Connector contract** (typed, minimal):

  ```ts
  interface AgentConnector {
    spawn(spec: SpawnSpec): Promise<AgentRef>   // throws SpawnError
    list(): Promise<AgentInfo[]>                // never throws; [] on backend outage
    status(id: string): Promise<AgentInfo>      // throws AgentNotFound
    stop(id: string): Promise<void>             // idempotent; no-op if gone
    capabilities(): AgentCapabilities           // {attach?, respawn?, supervisor:'none'|'ondemand'|'required'}
  }

  interface SpawnSpec {
    molStep: string        // bead id the agent claims — the stable key
    repoRoot: string       // worktree path to run in
    beadsDir: string       // resolved shared-store identity — connectors MUST
                           // claim here, not in their own store
    prompt: string         // rendered instructions (convoy formula text)
    env?: Record<string,string>
  }
  interface AgentInfo {
    id: string             // stable per molStep (see registry below)
    pid?: number           // backend-liveness handle; absent for remote
    molStep: string; backend: string
    state: 'spawned'|'running'|'exited'|'lost'|'stopped'
    worktree?: string; log?: string
  }
  ```

  `spawn` fails fast if the molStep already has a live AgentInfo (registry
  check) — that is what makes "no duplicate respawn" decidable.

- **agentId registry** — `<git-common-dir>/bro/agents.json`, atomic-write
  (tmp+rename) map `molStep → {agentId, backend, spawnedAt}`. Native keeps
  pid+exit-status alongside; external backends keep their remote handle.
  Respawn of the same molStep reuses the entry — id survives process death.
- **Beads claim stays the single source of truth across ALL backends**: any
  connector's agent claims its step via `beadsDir` in the shared dolt →
  `bro fleet` sees it regardless of who spawned it.
- Backend-specific config never leaks up: a connector translates
  `bro.config.json` + molecule into whatever its runtime needs (gascity
  packs, tmux sessions, paseo config). `bro agents up|down` owns the
  supervisor lifecycle; `native` is `capabilities.supervisor:'none'`
  (detached processes are self-sufficient).

## `bro fleet`

Read-only view, works regardless of backend: mols × steps × agents ×
worktrees × PR gates. Phase 1 one-shot table; `--live` TUI later; site
route over `bro serve`. An agent dead while its step stays claimed renders
as `lost — respawn?` — the respawn decision surface.

## Filetree

```text
packages/core/src/agents.ts           contract + facade
packages/cli/src/agent-connectors.ts  native connector + connector registry
packages/cli/src/commands/fleet.ts    bro fleet
packages/cli/src/commands/agents.ts   bro agents up/down/status
```

## Milestones

1. `bro-4bkv` spike: is gascity automatable? (CLI surface, generated
   config/packs, on-demand supervisor) — decides whether the gascity
   connector is viable or degenerate.
2. `bro-g4vn` MVP: facade contract + registry + native connector.
3. `bro-vf1j` `bro fleet` one-shot; `bro-q0f2` supervisor lifecycle;
   `bro-dr1s` `bro serve` facade host.
4. Connectors: `bro-cduq` gascity (gated on spike), `bro-uqkr` tmux;
   paseo/cao later (external repos — issue-first).
5. `bro-n54z` fleet `--live` TUI; `bro-1rir` fleet webui.
