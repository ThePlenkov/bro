---
scope:
  - packages/cli/src/commands/act.ts
  - packages/act/src/connector.ts
  - packages/cli/src/commands/act-wait.e2e.test.ts
  - skills/act/SKILL.md
  - site/content/docs/commands/act.md
---

# bro-b16er — act wait: self-detach option

## Problem

`bro act wait --merge --cleanup` still polls inside whatever process
armed it. In an exec-background shell that is the session itself: on
idle teardown or a turn end the shell dies, the wait dies, and the
recorded promise outlives the poller (night-stall retro bro-kmyvp —
the watch markers flag it stale only at the next session start).
`bro act rearm` already knows the resurrection shape — detached +
unref'd respawn, confirmed by the child's own marker — but nothing
lets the *arming* session pick that shape up front; the skill tells
agents to hand-roll `setsid`/`systemd-run`/tmux instead.

## Design

`bro act wait <PR> [wait flags] --detach` — self-detaching wait. The
parent resolves the target and flags, spawns the same `act wait`
argv (sans `--detach`) with `detached: true` + `unref()` — the
`respawnWatcher` spawn shape, shared — then confirms the child armed
by waiting for its live watch marker to appear, prints the pid and
exits. The wait, its `--merge`/`--cleanup`, and its marker are then
owned by a process no session teardown can reach.

- **Flag surface** — the child replays the whole wait contract:
  `--interval`, `--timeout`, `--merge`, `--cleanup`, `--bead`, the
  merge strategies (`--squash`/`--rebase`/`--admin`). `--cleanup`
  without `--merge` is rejected in the parent — a detached child
  erroring after the settle would report into a log nobody watches.
- **The record** — the child's own marker under
  `<git-common>/bro/watches/` is the durable record (pid + mode +
  workdir + bead): `act status` sees it, `act rearm` resurrects it,
  session-start flags it dead. No second registry.
- **The log** — the child's stdout/stderr appends to
  `<git-common>/bro/act-wait-<pr>.log` (capped like
  `post-merge.log`) so a detached wait's poll lines and settle
  verdict stay inspectable; `stdio: 'ignore'` is the fallback when
  the log can't be opened. `act rearm` respawns ride the same file —
  detached is detached, however it got there.
- **Confirmation** — same rule as rearm's: a resolved pid means the
  child's live marker was seen; a child that exited before arming
  reports failure (exit 1, log path named); a child still alive at
  the 10s deadline reports `marker pending` — honest, since its
  marker may land late and the pid is real either way. A child that
  exits 0 during arming is neither: an already-set gate finishes the
  wait (and its `--merge`) inside the spawn, so the parent reports
  `settled` instead of claiming a dead pid is watching — the marker
  window on an instant settle is a race the parent can lose.
- **Parent does less, not more** — `resolvePr` + flag validation
  stay up front so a typo'd PR or bad flag fails where the user
  reads stderr; auth still gates inside the child (the marker
  deadline catches a child that dies on it).

## Out of scope

- No dedup against an already-live watch on the same PR — a second
  `act wait` has never refused that; coverage markers reconcile it.
- Session-surviving merge supervision beyond the wait itself
  (`bro drive --every`) stays the fleet-wide answer.

## Plan

- [x] `cli/commands/act.ts`: `--detach` on `wait`; shared
      detached-spawn + marker-confirm helper; `respawnWatcher`
      delegates to it and gains the log; per-PR log under
      `<git-common>/bro/`
- [x] `act/connector.ts`: stop-gate nudge names `--detach` instead
      of hand-rolled setsid
- [x] `skills/act/SKILL.md`, `site/content/docs/commands/act.md`:
      `--detach` in the wait row and the watcher-survival policy
- [x] `act-wait.e2e.test.ts`: detach arms a confirmed live marker,
      detached `--merge` lands the PR after the parent exits,
      `--cleanup` without `--merge` refuses, `--json` shape
- [ ] `npm test` + typecheck, PR
