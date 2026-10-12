# bro-ihnlv — drive: 'green-occupied' gets a merge-path TTL

## Problem

`occupied()` always returns the safe verdict — every plane counts
"unverifiable" as live forever:

- a `.work` marker whose owner pid survives (bro-xlhm keeps it live
  past the 24h mtime window — indefinite),
- a `'spawned'` registry entry with no pid (remote backend — nothing
  can disprove it, so it is alive forever),
- a `/proc` cwd hit (a parked agent CLI sits in the worktree for days).

On a **green** PR any of those pins the `green-occupied` verdict
forever — drive skips the merge and re-reports the same line every
pass with no escalation. The owner is dead or silent; the PR rots.

The fixer/conflict paths are not the problem: spawning into a claimed
tree is the real hazard occupied() guards (bro-pywx), and a stale
occupant skipping a pass costs nothing urgent there. The merge path is
different — `bro act merge` only lands pushed, gate-approved work and
retires the worktree only when clean, so a false "orphan" verdict is
recoverable while a false "live owner" verdict is a permanent stall.

## Design

Merge-path TTL: occupancy without *proven activity* inside
`drive.occupancyTtlSec` (default 7200 — 2h) counts as an orphan →
adopt + merge. Each plane's proof carries an activity stamp:

| Plane | Activity stamp |
| ----- | -------------- |
| fixer/registry agent | max(`<agentId>.log` mtime, `spawnedAt`) — a silent agent's log froze with it |
| foreign watch marker | marker file mtime — heartbeating kinds restamp per pass; a `wait` marker's stamp is its start (a >2h wait is stalled, and merging only finishes what it would do) |
| worktree claim (`<gitdir>/bro/work`) | marker mtime |
| `.work` marker detail | marker mtime — re-armed on every arm-worthy command (`git push`, `bro act`, `bd --claim`); a session pushing keeps it fresh |
| `/proc` cwd hit | the worktree's own idle signal (`worktreeIdleMs` — dir/index/HEAD-reflog mtimes): a live process in a >2h-untouched tree is a parked owner |

Rules:

- `occupancyProofs()` becomes the shared ladder — a lazy generator
  yielding `{detail, activeAtMs}` in the current priority order.
  `occupied()` stays the first-proof read (same strings, same
  short-circuit; the blocked paths are untouched).
- Green path: any proof fresher than the TTL wins → `green-occupied`
  (detail = the freshest proof). All stale or unverifiable → the PR is
  adopted and flows into the normal orphan merge path; the verdict
  detail names the adoption (`adopted — <why> (silent …)`).
- The pre-merge `supervisedBy` re-check on the adopt path applies the
  same TTL — a stale marker must not veto the adoption it caused, or
  the bug resurrects (only a *fresh* mid-pass marker vetoes).
- A proof with no readable stamp is "no proven activity" → stale. That
  is the point: unverifiable occupancy must never hold a green PR
  forever.

Config: `drive.occupancyTtlSec` — seconds, floor 60s, default 7200.

## Plan

- [x] `proc-owner.ts` — `liveWorkEntries` (detail + mtime);
      `liveWorkDetails` delegates
- [x] `work.ts` — `worktreeClaimInfo` (detail + mtime);
      `worktreeClaim` delegates
- [x] `drive-config.ts` — `occupancyTtlSec` (default 7200, floor 60)
- [x] `drive.ts` — `occupancyProofs` generator; `occupied` on top;
      `greenOccupancy`; adopt→merge in `drivePr`; `registryAgents`
      carries `log`
- [x] tests — per-plane fresh/stale units; e2e: stale-occupied green
      PR → `merged`
- [x] `skills/drive/SKILL.md` occupancy/config; site fleet.md table
