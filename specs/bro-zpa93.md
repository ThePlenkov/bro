# bro-zpa93 — loop: detach spawnAgent from the tick

## Problem

`runQueue`'s alternation (bro-zsmwq) is right — servicePass
oldest-first, tryClaim under `loop.maxOpen` — but `pushItem` awaits the
ENTIRE worker run inside the tick. With `agentTimeoutMin` retired
(bro-9lpn3) a worker can legitimately live for hours, and for the whole
window the gate stack gets zero service: review threads go unanswered,
green PRs sit unmerged, conflicts accrete. The round-robin scheduler
only helps members that already exist — a bead being worked isn't a
member yet, so a long first worker blocks every other member's gate AND
every later claim behind it.

The hand-rolled `spawnAgent` also keeps the worker invisible: no
registry row, no fleet slot, no `.exit` record, no claim pinned under
the registry lock — exactly the unregistered-spawn shape the agents
facade exists to eliminate (a dead loop leaves a phantom worker no
`bro agents`/`bro fleet`/`bro drive` view can see).

## Design

Spawn the worker through the agents registry — the `bro agents up`
path: `conn.spawn(spec)` on the resolved connector, a detached `sh -c`
child in its own process group, its `.exit` record, prompt, and log
under `<git-common>/bro/agents/`, and the lead bead's claim pinned by
`claimStep` inside the registry-lock critical section.

### Member lifecycle — the worker rides the same lifecycle as its gate

`GateMember` gains an optional `worker` ref (`agentId`, `spawnedAt`
generation stamp, spawn-time ms, pid) and `pr` becomes optional:

- **Pending phase** (`worker` set, `pr` unset — the first worker):
  `serviceMember`'s first gate stage is `conn.status(agentId)` +
  the `.exit` file, never a host call. `running`/`spawned` → `kept`;
  the tick moves on and services the rest of the stack.
- **Terminal** → read `<agentId>.exit` (code + mtime — the crash
  window's honest wall-clock, not the next poll's latency):
  - PR found → the member arms the watch marker and JOINS the gate —
    identical lifecycle to the awaited-spawn member it replaces
    (`→ PR` line, `since` reset, `active` re-poll).
  - No PR → the same settle the old inline path ran: agent verdict →
    `closed`; `.exit` inside `loop.crashExitMs` → `parked` (environment
    crash, bro-sovl3); else → `failed` + reopen. A `blocked`/`stopped`
    worker parks with its cause named — reopening would respawn into
    the same wall.
- **Fix/rebase worker** (`worker` set, `pr` set): terminal → clear the
  ref, reset `since` (the worker's exit IS the gate re-entry), return
  `active` — the next poll decides by gate state exactly as before.

`maxOpen` now bounds in-flight workers too — a pending member occupies
its slot, so `--max-open 1` keeps the near-serial shape.

### Claims — the registry owns the lead's

`claimClump` no longer pre-claims the lead on the registry path:
`conn.spawn`'s `guardClaim`+`claimStep` lands it atomically (a
pre-claim reads as "claimed outside the agent registry" and refuses).
The pick probes `beadStatus` to keep `claimUpTo`'s raced-away skip
chain. Clump members still claim via `claimUpTo`; a refused spawn
releases them.

`SpawnError` maps to outcomes: `cap` (fleet full) → `hold` — the item
un-sees, member claims release, pushes wait one interval instead of
parking an open bead or hot-looping a full fleet; `conflict` (live
agent / foreign claim / respawn block) → `parked`, no note — the bead
isn't ours to annotate; everything else → `parked` + note.

### Exit polling — detected, never awaited

`conn.status(agentId)` walks the backend ladder (pidAlive →
stopped → harvested `exitStatus` → `.exit` file → `lost`), classifies
the cause into the registry, and answers `AgentNotFound` for a reaped
entry → settled as `lost`. A respawned same-id entry re-stamps
`spawnedAt` — the generation check refuses to inherit a foreign run's
clock. `.exit` mtime (or the log's last write, or now) feeds
`crashExitMs`; the member clock's merge deadline only applies to
gate-phase members — worker lifetime stays unbounded (bro-9lpn3).

### Per-member poll cadence — worker vs gate

A `kept` verdict stamps `nextPollAt` on the member with its stage's own
cadence: `WORKER_POLL_MS` (1s) while a worker is pending — the `.exit`/
registry probe is a local read, not a review-host fetch — and
`intervalS` once the member gates on a PR. The stack's idle sleep wakes
at the earliest member's own deadline (still bounded by the merge-
timeout park), so a worker's exit lands within ~1s without dragging
every PR gate into sub-interval host polls.

### Fallback — no shared store, no registry

`ctx.beadsDir === undefined` (non-beads tasks backend or an
unresolvable `bd where`) keeps the old awaited `spawnAgent` semantics —
the registry's claim plane needs a real beads dir to pin against.
`bro/loop/*.json` run records also remain the legacy path's read model;
registry workers are read through `bro agents`/`bro fleet` instead.

### Ambient provenance pins

Native spawn now filters `AGENT_PIN_KEYS` out of the ambient/spec env
before applying its own pins — the documented contract every other
backend already honors. Without it a `bro loop` launched inside a
worker would bleed the parent's `BRO_AGENT_PROVIDER`/`BRO_MOL_ID`/
`BRO_SESSION_ID` into the child's commit trailers (bro-fzot's exact
bug shape, and a parity regression vs `agentEnv`'s strip list).

## Bonus — the .exit survives the loop

A dead loop leaves the registry row + `.exit` + `.work` marker behind:
`bro agents status` can name the silent worker death the old
`bro/loop/*.json` audit hole (bro-snga4) could not, and `act rearm`'s
watch marker still carries the bead ids — a resurrected wait can
re-drive the member's gate half (bro-q6ppv).

## Non-goals

- Adopting a foreign LIVE worker on a picked bead as the member's own —
  a `conflict` refusal parks; resurrecting a dead loop's in-flight
  member is `act rearm`'s job.
- Routing-class assignment per bead (bro-zmned owns fleet.routing for
  the loop lane).
- Killing or bounding worker runtime — still an orchestrator decision,
  never a wall clock inside the spawn (bro-9lpn3).

## Validation

- `npm run build`, `npm run typecheck`, `npm test`.
- New e2e: a delayed first worker + an instant second — events must
  show B's PR merge inside A's worker window (the starvation bug's
  exact regression).
- Existing e2e: land/verdict/fail/crash/batch/fix/rebase/hang paths
  re-asserted against `<git-common>/bro/agents/` artifacts (.exit code,
  append log, registry entry).
