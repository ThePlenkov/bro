# bro-7dgu3 — fleet worktree disk footprint is unbounded

## Problem

The host accumulates `bro--*` worktrees without bound (observed: 70
trees ≈ ~950MB of node_modules each). `reapLoopLitter` — the fail-closed
sweep that reaps provably-done `loop/`/`stack/` litter (spec bro-ho09d)
— ran only at `bro loop` closeout and in `bro work prune --loop`. The
supervised drive pass (`bro daemon run --every` → `bro drive --every`,
the `bro-daemon.service` tick) never swept, so merges landing without a
cleanup caller — GitHub auto-merge, UI merges, manual `gh pr merge` —
strand their worktrees forever.

Compounding it: orphaned **nx daemons**
(`<wt>/node_modules/nx/dist/src/daemon/server/start.js`) from dead
fixers keep a dead tree "occupied" on every `/proc` plane
(`processesRootedIn` sees their cwd/argv inside it), so safe reaps read
as live — verified live: 15 of the swept trees were pinned only by nx
daemons, not sessions.

## Design — P0 (this spec's slice)

The daemon tick sweeps on its own cadence.

- `drive.litterSweepSec` (default 3600, 0 disables) bounds how often a
  drive pass runs `reapLoopLitter` with the loop-closeout context:
  `tasks`/`rev` from the pass's own facades, `stackPrefix: 'stack/'`,
  `loop.parkedKeep`/`parkedTtlDays` from config. The sweep rides at the
  top of `driveOnce` — a reaped branch never reaches `openFleetPrs`,
  and a just-killed daemon ghost stops pinning the pass's occupancy
  verdicts. A `--once` pass always sweeps when enabled (each
  invocation is a fresh throttle — orchestrator-pulse deployments are
  ticks too). A sweep failure is a pass warning, never a pass failure;
  under `--json` the sweep's helper output routes to stderr, same as
  the loop audit.
- `reapLoopLitter` gains a stale-daemon pre-step before the claim and
  verdict scans: for every worktree'd litter candidate, when **every**
  process rooted in the tree is nx-daemon-shaped
  (`nx/dist/src/daemon/` in argv), the daemons are SIGTERMed and the
  sweep waits a bounded moment for them to exit before the occupancy
  verdicts run. One non-daemon hit keeps hands off the whole tree — a
  live session's own daemon keeps company. Kills report on the reap as
  `killed` lines (`'would kill'` under `--dry-run`); the live-process
  guard in `removeMergedWorktree` still applies verbatim after the
  kill, so the daemon-specific carve-out never weakens the
  process-cwd safety rule.

## Out of scope (later phases, still open on the bead)

- P1 `bro work park --commit-wip` — rescue dirty trees' uncommitted work.
- P2 respawn reaps the prior attempt's clean tree.
- P3 fixer materializes worktrees on demand from remote branches.
- P4/P5 registry GC + cross-rig policy.

## Plan

- [x] `drive.litterSweepSec` config knob (drive-config.ts).
- [x] `reapStaleNxDaemons` pre-step in `reapLoopLitter` (work.ts),
      `LitterReap.killed` report lines everywhere the reap renders.
- [x] `driveOnce` sweep on the throttle (drive.ts).
- [x] e2e: daemon-tick reap + nx-daemon kill/keep cases
      (work.e2e.test.ts).
