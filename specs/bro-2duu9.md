# bro-2duu9 — one supervisor per repo: singleton hold for `bro drive` / `bro loop`

## Problem

Operators run respawn wrappers around the long-lived supervisors
(`while true; do bro drive; done` under setsid). Nothing stops two
wrappers — or a wrapper plus a manual invocation — from running the
supervisor concurrently: overnight two `bro drive` processes (00:37 and
03:52) supervised the same PRs at once, racing fixer spawns, merge
probes, and watch-heartbeat ownership. `bro agents up` is
registry-pinned; ad-hoc bash supervisors are not — the guard has to
live inside bro, not in the wrapper (retro bro-l63ji).

The existing pieces don't cover it: watch heartbeats only *report*
"another process is polling", and `acquireFileLock`'s abandoned bound
(`LOCK_ABANDONED_MS`, 15 min) robs even a live holder whose lock file
hasn't been touched — unusable as-is for a lifetime hold (the same
latent hole sits under `bro serve`'s hand-rolled `serve.json.lock`).

## Design

A lock file under `<git-common>/bro/` is the single-instance record —
one per supervisor: `drive.lock`, `loop.lock`. `bro drive` (any mode)
and `bro loop` (the supervised run; `--dry-run` exempt) take theirs at
start and hold it for the process lifetime.

- **`holdFileLock(lock)`** (new, core filelock): `acquireFileLock` plus
  an unref'd interval that refreshes the lock's mtime well inside the
  abandoned bound — a live hold is never read as stale by contenders or
  the janitor's `*.lock` sweep, and a dead holder's leftover is still
  stolen/reaped exactly as today. If the file vanished mid-hold the
  heartbeat re-links our own token (a contender who already linked
  keeps it — EEXIST loses quietly). The timer is `unref`'d so a
  `--once` pass is never kept alive by its own guard.
- **`awaitFileLock(lock, { onStandby })`** (new, core filelock):
  `holdFileLock` retried through `LockTimeout` — a duplicate does not
  refuse, it *stands by*: cheap and correct for any wrapper shape
  (no `sleep` needed; a respawn serializes behind the incumbent and
  takes over when it dies). `onStandby(pid)` fires once per wait cycle
  so a blocked second supervisor stays observable in the log.
- **`lockHolderPid(lock)`** (new, core filelock): the pid inside a held
  lock's token, for the standby message.

Commands print `bro <cmd>: already supervised by pid <N> — standing by`
on contention. A common-dir that can't be resolved skips the guard
(same degradation posture as serve's null state path) — never blocks a
run on a missing state dir.

## Plan

- [ ] `packages/core/src/filelock.ts`: `holdFileLock`, `awaitFileLock`,
      `lockHolderPid`; export from `index.ts`
- [ ] `bro drive`: acquire `bro/drive.lock` in `runDriveCommand` right
      after `mainWorktree()` — before auth/facade planes, so a standby
      is cheap; hold across `--once` and `--every`
- [ ] `bro loop`: acquire `bro/loop.lock` around `guardedRun` in
      `runLoopCommand`, after the `--dry-run` return
- [ ] tests: heartbeat keeps a live hold unstealable past the abandoned
      bound; standby resolves when the incumbent releases; dead holder
      is taken over without a wait

## Acceptance

- Two concurrent `bro drive` invocations on one repo: the second waits
  as standby, then supervises after the first exits — never concurrent.
- A `bro drive`/`bro loop` running hours keeps its hold: janitor
  `*.lock` sweeps and contender steals skip a heartbeated live lock.
- A killed supervisor's lock is stolen by the next starter — respawn
  wrappers self-heal without manual cleanup.
