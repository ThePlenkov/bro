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

`agents` facade over orchestrator backends — selected through the
existing `connectors.agents` seam in `bro.config.json` (explicit
`--connector` → `connectors.agents` → `matchRemote`/`matchDir` →
registry order; `native` is the designed default). Backend-specific
knobs live under `agents.<backend>` (e.g. `agents.gascity.configDir`).
- **Connector contract** (typed, minimal):

  ```ts
  interface AgentConnector {
    spawn(spec: SpawnSpec): Promise<AgentInfo>  // throws SpawnError (duplicate/conflict)
    list(): Promise<ListResult>                 // {agents: AgentInfo[], degraded?: string}
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

  `spawn` dedup must correlate both planes, not fail on claim alone —
  otherwise a crashed worker's stale `in_progress` claim makes respawn
  impossible:

  - **fail fast** only when the molStep is claimed AND the claim resolves
    to a *live* agent (registry entry with running/spawned state, or a
    remote backend reporting it alive);
  - **respawn path** — molStep claimed but its agent is `lost`/`exited`:
    spawn re-claims/rebinds the step (the claim transfers to the new
    worker) and reuses the registry entry's `agentId`;
  - **unclaimed** molStep: spawn claims it fresh.
  - **indeterminate liveness** — if the molStep is claimed but the
    backend cannot resolve the agent state (unreachable supervisor, a
    failed liveness probe), spawn fails with `SpawnError` and MUST NOT
    re-claim, rebind, or start a worker. Respawn requires a successful
    resolution to `lost`/`exited`, never a guess over a stale claim.

  `spawn` is one serialized critical section per molStep, not a
  read-then-act: the dedup probes (registry liveness + shared-store
  claim), the decision, the claim/rebind into `beadsDir`, and the worker
  start MUST be atomic against concurrent `spawn()` calls — two racing
  spawns end with exactly one worker. A `tmp+rename` registry write
  makes each *write* atomic but not the read→decide→claim sequence, so
  it alone does not satisfy this contract. v1 anchors the section on an
  O_EXCL lockfile at `<agents.json>.lock` (broken only after the holder
  proves dead — an age-based break can steal the section mid-start — or
  fenced by a lease renewed for the full section) that every backend's
  `spawn` wraps around dedup → claim → backend start → registry patch —
  a per-repo hold, strictly stronger than a per-step key. Where
  `beadsDir` offers a native atomic claim-and-rebind keyed by molStep,
  that is equivalent only if the claim is an exclusive reservation held
  across dedup through worker start and registry patch — preventing
  competing spawns from both patching the registry or starting workers,
  and leaving the registry entry matching the sole started worker.

  `list()` returning `degraded` (backend unreachable) means `bro fleet`
  renders `unknown`, never `lost — respawn?` — a failed read must not
  look like a dead fleet. **Scope note:** cross-clone exclusivity is
  best-effort — `refs/dolt/data` sync is not atomic across clones; true
  multi-machine dedup needs a shared lock plane and is out of v1 scope
  (single-repo, single-machine fleet first).

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
as `lost — respawn?` — the respawn decision surface — only on a
successful `list()`; a `degraded` list renders `unknown` instead.

`bro serve` is the facade host for thin clients (TUI/webui). Trust
boundary, v1: binds `127.0.0.1` only, no remote exposure. Loopback alone
is not a write barrier — a hostile web page can fire cross-site requests
at it — so the server enforces a browser-origin control: every request
needs a loopback `Host` (a rebound name is 403 — DNS rebinding), and
writes (POST/PUT/PATCH/DELETE) refuse a non-loopback `Origin` (403 — the
browser stamps every cross-site request); body-bearing writes
(POST/PUT/PATCH) also require `content-type: application/json`, a header
a browser can't send cross-site without a preflight the server never
answers. Remote orchestration, if ever, is a separate spec.

## Filetree

```text
packages/core/src/agents.ts           contract + facade
packages/cli/src/agent-connectors.ts  connector registry + built-in backends (native, tmux, gascity)
packages/cli/src/commands/fleet.ts    bro fleet
packages/cli/src/commands/agents.ts   bro agents up/down/status
packages/cli/src/commands/serve.ts    bro serve (facade host for clients)
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
