# bro-0vj14 — `bro status`: worktree plane — claimed checkouts on the live board

## Problem

`bro status` is the compact live board thin clients poll — beads,
fleet, drill, watch, build, act — but it has no worktree plane. A
sibling checkout claimed by `bro work enter` is live work-in-progress,
yet on the board it surfaces only indirectly as an in-progress bead
row (and only when a bead was claimable at all). Dogfood run
df-core-workflow-mv6ldgld-2c9d hit exactly this: the step "the
worktree reads as claimed live work" had no surface to check. `bro
work list` is the real worktree plane, but it is a separate verb a
per-tick reader doesn't know to call — and it doesn't show the claim
either.

## Design

`collectStatus` gains `worktrees: StatusWorktree[]` — every checkout
from `git worktree list --porcelain`, each carrying:

- `name`/`path` — basename for the board, the absolute path for a
  thin client that wants to open it;
- `branch` — shortname, absent when detached;
- `state` — `bro work list`'s own vocabulary (`clean | dirty(n) |
  gone | LOCKED | PRUNABLE`), present only where the board probed.
  LOCKED/PRUNABLE/gone come free with the porcelain metadata;
  `clean|dirty(n)` costs a `git status` subprocess per tree, so the
  probe lands only on live work — claimed trees, main, and cwd (cwd
  reuses the header's own dirty count, free), capped at 16 probes so
  a rig parking dozens of siblings stays ms-cheap;
- `claim` — the live in-tree claim marker's detail
  (`<gitdir>/bro/work`, stamped by `bro work enter`; read through
  `worktreeClaim`, so an aged-out marker stops reading as claimed);
- `main` / `here` — the primary checkout and the board's own cwd
  (the cwd is not necessarily main — loop and drive workers run in
  linked trees).

Cost stays inside the board's local-only contract: one porcelain
list, a marker file read per tree, and the bounded state probes. A
failed `worktree list` is `worktrees: []`, never an error — the
empty-sections rule holds.

Render gains a `worktrees: N linked[, M claimed]` section between the
beads queue and the fleet rows. Rows print only for live work —
claimed trees and the board's own checkout (`◐` claimed, `·` not,
`← here` on cwd); parked litter reads as the count, `bro work list`
is the drill-down. The main row stays in JSON but isn't rendered:
the `board:` header line already covers the ambient checkout.

`bro work list` also learns the claim column — the dedicated plane
shows the same live-claim read the board does, so "claimed live work"
is checkable on either surface.

## Plan

- [x] `readWorktrees` + `StatusWorktree` in status.ts — reuse
      `parseWorktreePorcelain`/`stateOfWorktree`/`worktreeClaim` from
      work.ts
- [x] `worktrees` on `BroStatus` + the render section
- [x] `bro work list` prints the live claim after the state column
- [x] `planes/work.ts` board carries `worktrees` — the serve facade
      projects the same board shape
- [x] `skills/status/SKILL.md`, `skills/work/SKILL.md` — the section
      documented in the thin-client contract
- [x] tests — linked worktree row (branch/state/claim/here), main
      flagged, non-git dir answers `[]`
