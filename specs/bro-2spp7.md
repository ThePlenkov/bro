# bro-2spp7 — loop: WIP cap disk watermark

## Problem

`loop.maxOpen` is static and resource-blind. It counts open gate-stack
slots but never asks whether the machine can pay for another one. The
incidents on record:

- **ENOSPC killed the loop twice.** One open slot costs ~350M of disk
  (the worktree checkout plus bootstrap/agent litter — this repo's
  `npm install` alone lands most of it; prompt/scratch files pile onto
  tmpdir). `maxOpen=3` against a disk with under a gigabyte free is a
  death loop: worktree add or the agent's writes fail mid-run, the
  item settles failed/parked, the freed slot claims the next bead into
  the same wall.
- **A fixed cap mis-prices the phases.** Open slots during review
  latency are nearly free — the member waits, the worktree sits. Open
  slots during conflict storms are debt: each member drifts further
  from a moving base and rebase rounds compound. `maxOpen` cannot tell
  cheap occupancy from expensive occupancy; the resources it burns
  (disk) are the signal it doesn't read.

## Design

v1 is static cap + disk watermark. The AIMD congestion window
(clean land → +1 headroom, conflict burst → halve) is a measured
upgrade and is deliberately NOT in this spec — the floor alone kills
the ENOSPC death loop.

### Slot-priced floor — admission, not eviction

One open slot is priced at `loop.worktreeMb` (default 400 — the ~350M
observed per worktree, rounded up). A push is admitted only while
**every filesystem the run writes to** still covers the floor:

```
free_bytes(path) >= diskMinSlots * worktreeMb * MB     for each probe
```

`loop.diskMinSlots` (default 2) is the margin in slot units: after the
new worktree lands, at least one slot's price remains before the disk
runs dry. `diskMinSlots: 0` disables the watermark.

The probes are the filesystems a claim actually writes to:

- `dirname(ctx.root)` — the sibling `<repo>--<id>` worktree dirs and
  the agent's litter land there;
- `os.tmpdir()` — prompt files (`<tmp>/bro-loop/<slug>/prompt.md`) and
  agent scratch (package caches, temp builds) land there. `/tmp` filled
  mid-run in one of the recorded incidents.

`statfsSync` (`bavail * bsize` — the unprivileged-available count, not
the root-reserved `bfree`) re-runs at every push attempt: merges that
remove worktrees re-admit the queue on the next tick without any
accounting of our own. An un-probeable path is skipped and named once
per run — a watermark that cannot see reports rather than gates; the
underlying fs failure is an ops problem, not a hold verdict.

### The hold — same shape as the fleet cap

A breached floor in `tryClaim` (after the cheap `maxOpen`/`--max`
checks, before `claimClump` touches the store) does exactly what a
full fleet does: return `false`, stamp `pushHoldUntil` one interval
out, and let the tick go back to gate service. Nothing is claimed, so
nothing is stranded; nothing is failed, so nothing is parked. The hold
says one `say()` line on the transition edge only — a re-breach inside
the same episode does not re-log; recovery says one resumed line.

The heartbeat stays honest: while pushes hold and the stack is empty
the idle stage reads `idle (disk floor)`, so a disk-stuck run names
its wait in `loop: alive —` lines instead of looking like a healthy
idle.

`--dry-run` reports the verdict too: `disk: N MB free on <path>
(floor M MB)` or the hold verdict — an operator sizing `maxOpen` sees
the real headroom before committing a run.

`--disk-min-slots N` mirrors `loop.diskMinSlots` per run —
`--disk-min-slots 0` is the emergency escape when the check itself
misprices (a filesystem where a slot genuinely costs less).

### Why this is the effective cap

The bead's formula `cap = min(maxOpen, diskHeadroom)` and the per-push
floor are the same admission rule. Members already on the stack have
their disk spent — `free` reflects it — so "free covers N×cost" at
push time bounds total occupancy exactly the way
`stack.length + floor((free − keep)/cost)` would, without needing to
estimate what a member still holds.

## Non-goals

- **AIMD congestion window** — land-clean/collision feedback shrinking
  and growing the cap is the v2 the bead describes; v1 ships the
  floor, which alone prevents the ENOSPC death loop.
- **Eviction of held worktrees** — members on the stack are never
  starved out for disk; the floor gates NEW claims only.
- **Admission control on other commands** — `bro work enter`,
  `bro stack push`, `bro agents up` create worktrees too; the floor is
  a `bro loop` policy for v1 (the exported helper can be adopted
  elsewhere later).
- **Parked TTL / dead-worker reaping** — the sibling bead bounds that
  tail; kept worktrees from parked members are out of scope here (the
  probe still sees their cost as reduced free space, which is the
  correct signal).

## Validation

- `npm run build`, `npm run typecheck`, `npm test`.
- Unit: `diskFloorBreach` — below floor on ANY probe → breach; floor
  disabled (`diskMinSlots` 0) → admit; empty probe list → admit;
  config floors (`worktreeMb` ≥ 1, `diskMinSlots` ≥ 0 valid).
- e2e: a `worktreeMb` priced above real disk holds every push — the
  bead stays `open` (never claimed, never parked), the hold line and
  the `idle (disk floor)` heartbeat stage report the wait; dry-run
  prints the disk verdict instantly.
