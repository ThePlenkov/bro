---
parent: bro-7xgk
scope:
  - packages/core/src/config.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/fleet.ts
---

# bro-7xgk.1 — fleet cap: maxConcurrent knob enforced at spawn

## Problem

bro has no limit on how many agents run at once. The only concurrency
knobs cap HTTP fan-out (`pooled(..., 4)` in the review packages);
nothing bounds fleet size, while the product thesis is maximum parallel
agents. On 2026-10-03 eighteen live sessions armed across three
worktrees and the account hit an inference wall that local accounting
could not explain. The binding constraint is a per-account hourly
inference budget, not coordination — a fleet cap is the one control
that converts an invisible wall into a predictable admission decision.

## Design

### Config — `fleet.maxConcurrent`

New `fleet` section in `packages/core/src/config.ts` (a CORE section, so
`loadConfig` applies it everywhere — worktree config inheritance
included). `maxConcurrent` is a non-negative integer, **default 3**;
`0` disables the cap (same "0 disables" convention as
`act.maxRounds`). Invalid values fall back to the default, never widen
the fleet silently.

`loadAgentEnv` carries it as `env.fleet` so every connector factory
sees the same value.

### Enforcement — the shared spawn prologue

`prepareSpawn` in `packages/cli/src/agent-connectors.ts` is the single
prologue every built-in backend runs under the agent-registry lock —
the cap check lives there, after dedup and claim checks, before the
registry write and claim land. Placement under the lock is the point:
the occupancy count rides the same critical section as the write, so
two racing `bro agents up` calls cannot both see headroom.

A refusal throws `SpawnError` naming the cap and the current occupancy —
never a silent refuse.

### Occupancy semantics — occupy until proven dead

The cap counts **across all backends** — the budget wall does not care
which runtime burns it. `fleetOccupancy(dir, home, registry, env)`
walks the registry and counts an entry unless it is proven dead:

- `native`: `nativeState === 'running'` (pid alive + identity pin).
- `tmux`: `has-session` running OR the probe inconclusive — an
  unverifiable session may still be a live worker, so it occupies.
  An entry with no legal session name (corrupt `session`, unsafe
  `agentId`) has nothing the probe could find — it frees the slot,
  the same verdict `list()` reports.
- `gascity`: `gc session list` (one lazy call) — running or unstarted
  (`spawned`) sessions occupy; an absent session frees the slot only
  when the supervisor can verify; an unreachable city counts occupied.
- unknown backend: recorded death (`stopped`/`exitStatus`) frees the
  slot; anything else occupies.

Fail-closed on every unverifiable probe — the cap exists to not
overshoot an invisible budget, so maybe-live is treated as live.

Respawn interplay: a dead entry occupies no slot, so respawning a lost
worker under a full cap is refused only when OTHER live agents fill it.

### Surfaces

- `bro agents status` — the table gains a `fleet: N/M occupied` line
  above it; `--json` gains `occupancy: { occupied, maxConcurrent }`.
- `bro fleet` — same line above the table (and in the `--live` header);
  `--json` gains the same `occupancy` object. Occupancy is the same
  fail-closed registry count the prologue enforces — unverifiable
  entries keep their slots, so a degraded backend can't make the
  surface under-report the fleet.

### Out of scope

`bro loop`'s raw `spawn('sh')` child is a supervised one-at-a-time
worker, not a registry agent — the cap binds the registry fleet
(`agents up`, `drive`, `serve`, convoy fan-out), not the loop's own
child.

## Plan

1. `fleet` section + `DEFAULT_CONFIG.fleet.maxConcurrent = 3` in core
   config; `AgentConnectorEnv.fleet` + `loadAgentEnv`.
2. `fleetOccupancy` + cap check in `prepareSpawn`; all three factories
   pass `{ max, env }`.
3. Occupancy surfaces in `bro agents status` and `bro fleet`
   (text + `--json`).
4. Tests: `fleet` config normalization; cap refusal (spawn max, next
   refuses naming cap + occupancy); dead agent frees the slot.
