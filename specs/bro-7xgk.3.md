---
parent: bro-7xgk
scope:
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/doctor.ts
  - packages/cli/src/commands/fleet.ts
---

# bro-7xgk.3 — budget observability: local-estimate spend in doctor/fleet

## Problem

The 2026-10-03 inference wall was invisible until it hit: nothing in bro
reports spend against the provider's hourly window, so the failure
surfaced as convoy workers exiting rc=1 and a queue backing off —
indistinguishable from flaky infrastructure. Detection exists (the
session-start banner counts live armed sessions) but nothing connects
spawns, deaths, and provider resets into a budget picture. bro cannot
read the provider's counter — but it doesn't need to: every spawn
stamps `agents.json`, every recorded death harvests a `cause` and a
`resetAt`. A local proxy is enough to spot overshoot and to explain it
afterwards.

## Design

### `budgetSnapshot` — one registry walk

`packages/cli/src/agent-connectors.ts` gains
`budgetSnapshot(dir, home, registry, env, now?)` next to
`fleetOccupancy`, plus `budgetSnapshotFor(dir, env)` for the common
read-it-yourself call. It walks the registry once with the same
memoized probes `fleetOccupancy` uses, so "live" is the same fail-closed
verdict admission enforces — a maybe-live entry counts. The walk calls
`ensureExitCause` on every entry (native's path already does via
`entryOccupies`; calling it directly covers tmux entries and keeps the
causes list honest on a read that never touched the death ladder).

Shape:

```ts
interface BudgetSnapshot {
  basis: 'local-estimate'   // in-band disclaimer, not a comment
  limits: string[]          // the measurement limits, spelled out
  entries: number           // registry rows read
  live: number              // fail-closed occupied count
  blocked: number           // dead on a budget wall, block still holding
  maxConcurrent: number     // fleet cap, 0 = uncapped
  spawnedLastHour: number   // respawns count — a respawn is a fresh burn
  spawnedPerHour: { hour: string; count: number }[]  // ascending
  resets: { step, agent, cause, resetAt, holding }[] // observed provider resets
  causes: { step, agent, backend, cause }[]          // last known failure per agent
}
```

`limits` is a constant array, always present:

- counts bro registry agents only — interactive sessions and foreign
  tools are invisible;
- spawn history is bounded by janitor retention — reaped entries no
  longer count;
- causes classify from log tails — a provider wall that prints nothing
  reads `crash`;
- the registry keeps the latest run per step — earlier failures' causes
  are gone.

`spawnedPerHour` buckets `spawnedAt` by truncated UTC hour; unparseable
or absent timestamps skip. `resets[].holding` is `agentEntryBlocked` —
a reset whose time already passed is history, not a live block.

### Surfaces

- `bro fleet --json` — `FleetPayload` gains `budget: BudgetSnapshot`;
  `collectFleet` computes it once and derives `occupancy.occupied` from
  `budget.live` (one registry walk, one verdict). The text table and
  `--live` frame are unchanged.
- `bro doctor` — a `budget` section prints after the check block:
  `live/cap`, spawned in the last hour, resets (with whether the block
  still holds), and per-agent causes, followed by a `limits` line so the
  numbers can't read as provider truth. `--json` gains
  `budget: BudgetSnapshot` — the same shape fleet exposes. The section
  always renders, zeros and all — an empty registry is a true reading,
  not a skipped probe. `budgetLines(snapshot)` in agent-connectors owns
  the snapshot→text mapping.

### Out of scope

No provider quota APIs, no token counting — bro counts what it causes
(spawns, agents, observed resets), never what the account reports.
Interactive `bro loop` children and hand-rolled spawns are invisible by
construction (same boundary as the cap).

## Plan

1. `budgetSnapshot`/`budgetSnapshotFor` + `budgetLines` in
   agent-connectors; shared memoized probe helper with fleetOccupancy.
2. `collectFleet` carries `budget`; `occupancy` derives from it;
   `--json` emits it.
3. doctor renders the section and adds `budget` to `--json`.
4. Tests: snapshot over a fixture registry (spawn buckets, live via
   `pid: process.pid`, blocked/holding resets, lazy cause harvest);
   `budgetLines` rendering; fleet `--json` payload shape; doctor
   section in `--json`.
