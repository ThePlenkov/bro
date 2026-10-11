# bro-ybrja — `bro daemon`: the project-scoped process owner

## Problem

The session pulse (bro-killn) gave the orchestrator a bounded observer
that rearms itself from lifecycle hooks — but an observer is not an
owner. The fleet still has no long-lived process that owns review
passes, fixer spawns, and merges between sessions: `bro drive --every`
is that loop, yet it has no lifecycle — no `up`, no `status`, no
`down`, nothing the watchdog can name.

## Decision

`bro daemon` — a userspace daemon in the dockerd/containerd sense:
started and killed by the session, project-scoped, never installed at
boot. Naming settled in bro-oy3k1: **daemon**, not supervisor (Gas
City's term; also over-promises restart/policy semantics). The three
roles stay orthogonal:

| Role | Command | Owns |
| ---- | ------- | ---- |
| owner | `bro daemon up` | the drive pass — gates, fixers, merges |
| observer | `bro watch --every --for` | noticing — the bounded pulse |
| surface | `bro serve` | debugging — HTTP/JSON |

## Mechanics

- `bro daemon up [--every SEC]` — orchestrator-only
  (`BRO_AGENT_ID` refuses, exit 2 — same teeth as `bro drive --every`).
  Spawns `bro daemon run --every SEC` detached + unref'd with stdout to
  `<git-common>/bro/daemon.log`, records the armer in
  `<git-common>/bro/daemon.json`. Idempotent: a live `drive.lock`
  holder — daemon-spawned or a raw `bro drive --every` — reports
  `already`, never doubles.
- `bro daemon run` — the supervised loop itself; delegates to
  `runDriveCommand(['--every', SEC])` so the existing guard, the
  one-per-repo `drive.lock` hold, heartbeat emission and pass retry all
  apply unchanged. Not for direct use.
- `bro daemon status` — `drive.lock` holder (or live recorded armer
  covering the pre-lock window), the record, the log path.
- `bro daemon down` — SIGTERM the holder, clear `daemon.json`.
- `daemon.json` vs `drive.lock`: the record is *who armed it*; the
  lock is *who is alive*. A live unrecorded holder is a manual drive;
  a dead recorded one is the restart signal.
- Task agents stay detached registry peers — the daemon owns their
  scheduling, never their parentage. `daemon down` kills the owner,
  not the fleet.

## Watch integration

`collectSnapshot` gains a `daemon` plane: `{live, pid, recorded}` from
pure fs+pid reads. Rendered as the `daemon` section; a
recorded-but-dead daemon lands in `attention`
(`daemon recorded but dead — 'bro daemon up' restarts`) — the pulse
notices, a session acts.

## Acceptance

- [x] `daemon up` refuses under `BRO_AGENT_ID` and when a supervisor is
      live (daemon or raw drive)
- [x] `daemon up` spawns detached, writes `daemon.json`, logs to
      `daemon.log`
- [x] `daemon status`/`down` key off `drive.lock`, tolerate stale
      records
- [x] watch snapshot renders the daemon section and escalates a dead
      recorded daemon to attention
- [x] tests: record round-trip, probe matrix (live/dead lock ×
      live/dead record), up-decision matrix, render lines

## Deliberately out of scope (next slices)

- Queue/convoy progression inside the pass — the daemon pass is
  `driveOnce`; widening it is the rig-engine work (bro-oy3k1)
- Queue-empty self-termination and `--until` conditions
- `Stop`-hook awareness of a dead daemon (today: attention line only)
- Registry-level agent parenting (agents stay detached peers)
