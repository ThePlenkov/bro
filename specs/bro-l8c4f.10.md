---
parent: bro-l8c4f
scope:
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/agent-connectors-gascity.test.ts
  - docs/**
  - README.md
---

# bro-l8c4f.10 — Зафиксировать scheduler/provider ownership BRO ↔ Gas City

Parent: `bro-l8c4f` (principal audit 2026-10-18 — gascity-ownership).

## Problem

Gas City is already a backend connector. The audit (bro-l8c4f) asks to
fix ownership of claims/spawn/retry/reconciliation/shutdown/gate between
BRO and Gas City: publish an integration runbook with a single owner per
lifecycle phase, clarify Gas City is a complement (not Gas Town) and
not a reason to build a second scheduler. Lifecycle diagram and ownership
table must include recovery. Fixture coverage must be backed by versioned
real-gc conformance evidence, not only stub tests.

## Terms

- **BRO (broker/orchestrator)** — the broker-side logic in bro: facade
  contract enforcement, dedup/claim coordination via shared beads store,
  registry/agentId lifecycle, spawn serialization/dedup policy,
  respawn decisioning, fleet visibility, stop/idempotency, and gating
  semantics (owner of "when to spawn/retry/stop/reclaim").
- **Gas City (gc)** — the external city runtime: supervisor/process
  management, session/agent processes, routing/sling mechanics, provider
  command execution (`city.toml` owns provider command), city lifecycle
  (`gc start/stop`), and its own reconciliation. It is a complement,
  not a hardcoded Gas Town and not the source of a second scheduler.
- **Shared store** — `.beads/` dolt DB (adopted as rig). Claims live
  here; both sides must converge on it.

## Ownership table (single owner)

| Phase | Owner | Rationale / boundaries |
| --- | --- | --- |
| **Claims / assignment** | **BRO** | Claims go to the shared beads store (`bd`/task store) via the connector path; Gas City must adopt the repo as rig so the rig's beads DB is the repo store. BRO enforces dedup: "live session on step refuses second spawn", "foreign claim refuses spawn", respawn allowed only when agent is lost/exited or explicitly stopped. `gc sling --force` is never used (claimless dispatch forbidden). |
| **Spawn / bootstrap** | **BRO orchestrates; gc executes** | BRO decides *when/if* to spawn (policy, dedup, serialization), prepares per-step agent config, ensures rig/adoption, ensures city started as needed. Gas City owns provider command (`city.toml`), agent execution environment inside sessions, and the actual process spawning/routing. BRO never assumes gc runs arbitrary provider proxies it doesn't control. |
| **Retry / respawn** | **BRO** | Respawn decisioning lives in BRO (registry reuse by molStep/agentId, detect lost/exited/stopped, rebind claim). On respawn, BRO may call `gc session reset` to reuse a surviving session (preserving alias/bead) rather than creating duplicates. If session is gone but supervisor reachable → treat as lost (BRO decides respawn path); if supervisor unreachable → degraded read, do not guess lost. |
| **Reconciliation / liveness** | **BRO + gc (cooperative)** | gc provides session state via `gc session list --json`; gc supervisor provides liveness oracle. BRO interprets states into `AgentInfo.state` (closed→exited, active→running, suspended→stopped), treats missing sessions as lost only when supervisor is verifiably running, else degrades (omits/unknown) — never fabricates `lost`. BRO owns registry reconciliation against shared store claims. |
| **Shutdown / stop** | **BRO requests; gc terminates** | BRO calls `gc session close` (terminal op). `gc kill` is not used as the normal path (races reconciler). Idempotent stop: if session already gone and state consistent, stop is a no-op/clean. If close fails but session verifiably gone → clean stop; if session still lives → stop must fail (do not mark stopped). City stop via `gc stop <city>` is city-scoped; **BRO must never stop the machine-wide supervisor** (other cities may ride it). |
| **Gate / admission** | **BRO enforces** | Spawn admission: policy checks, config mutability, provider resolution rules (if provider-resolved worker would ride gc, refuse — gc owns provider via city.toml), dedup across registry+claim planes, serialization. Indeterminate liveness (unreachable supervisor, failed probe) → spawn fails with `SpawnError` and MUST NOT re-claim/rebind/start a worker. |

## Lifecycle diagram (with recovery)

```text
BRO                        GC (Gas City)
|                          |
|--policy/dedup------------>|  (check registry + shared store claims)
|  (admit/reject)           |
|                          |
|--ensure city/rig--------->|  initCity (city.toml if missing), rig add --adopt,
|                          |  gc start <city> (ensure supervisor up)
|                          |
|--write per-step agent--->|  agents/<molStep>/ (work_dir=repoRoot, env pins)
|                          |
|--ensure session--------->|  if alive -> gc session reset <id>; else gc session new
|                          |    (on parse failure of new -> close orphan alias)
|                          |
|--claim + dispatch------>|  gc sling <molStep> <molStep> (NEVER --force)
|                          |  gc session submit <prompt>
|                          |
|<--state/liveness--------|  gc session list --json, gc supervisor status --json
|                          |
|--reconcile-------------->|  BRO maps states; lost only if supervisor running + missing;
|  (lost/exited/stopped)   |  else degraded -> unknown/omitted
|                          |
|--retry/respawn---------->|  if lost/exited/stopped -> reuse agentId, reset or new as above
|                          |  (atomic dedup via serialization; claim rebind as needed)
|                          |
|--stop------------------>|  gc session close (idempotent). If fails but gone -> ok;
|                          |  if fails and lives -> error (do not mark stopped)
|                          |  gc stop <city> only (never gc supervisor stop)
```

**Recovery notes:**
- Crash between spawn steps → registry may have partial state; BRO must detect via liveness and only respawn on confirmed lost/exited.
- Orphan session from failed `session new` (unparseable output) → closed by alias.
- Sling failure → session closed by failure path, registry entry marked with `spawnError` and remains respawn-able as appropriate.
- Supervisor down/unreachable → reads degrade (no false `lost`), spawn fails on indeterminate liveness (no guess).
- Foreign claim (claimed by someone else, no registry entry owned by this molStep) → spawn refused.

## Conformance (versioned real-gc)

- **Stub conformance (existing):** `packages/cli/src/agent-connectors-gascity.test.ts` covers duplicate spawn, foreign claim, respawn/reset, list mapping, lost vs degraded, stop idempotency, config/env, etc., using the `FAKE_GC` shim.
- **Versioned real-gc conformance:** add support for running against a real `gc` binary when explicitly enabled (e.g. `BRO_REAL_GC=1` and `gc` on PATH at a known tested version). Record `gc --version` (or equivalent) as the tested version in test output/evidence. Conformance fixtures must be captured against that version and referenced as versioned evidence (not ad hoc manual runs). Tests that hit real gc must be opt-in and clearly marked (skipped by default). Evidence of passing runs against the pinned version is required for acceptance.

## Acceptance criteria
- [ ] Lifecycle diagram and ownership table included (with recovery) in this spec/docs.
- [ ] Single owner defined per phase: claims/spawn/retry/reconciliation/shutdown/gate.
- [ ] Documentation/runbook published (see docs below) stating Gas City is complement (not Gas Town), no second scheduler.
- [x] Fixture coverage backed by versioned real-gc conformance evidence (not only stub tests) — opt-in real-gc tests + version capture.

## Implementation plan
1. **Spec first (SDD):** this file is the spec (bro.config.json has `sdd.mode: "gate"`).
2. **Document ownership/runbook:** add integration runbook under `docs/` (or update README) with ownership table and lifecycle diagram; reference from gascity connector header.
3. **Tighten ownership comments in code:** ensure connector comments/state ownership clearly (BRO owns policy/dedup/retry/gate/claims coordination; gc owns provider/execution/supervisor/lifecycle mechanics). No redesign.
4. **Add versioned real-gc conformance scaffolding:** extend gascity tests with opt-in real-gc path that records `gc` version and runs a minimal conformance suite against a real binary when `BRO_REAL_GC=1` (skip otherwise). Capture evidence format.
5. **Regression checks:** keep existing fake-gc tests passing; add any missing ownership assertions if needed.

## Non-negotiables
- Spec first per SDD gate.
- Preserve grouped CLI + permanent flat compatibility aliases, one portable skills tree, existing semantic facades.
- No breaking redesign without owner alignment.
- Do not treat advisory/fail-open UX as security enforcement.
- Gas City complement, not Gas Town; no second scheduler.
