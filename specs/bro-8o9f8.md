# bro-8o9f8 — lock-holder liveness bounded by the steal rule (pulse/daemon reuse-blind pidAlive)

## Problem

`pulseRearm` consults `pulseLive()` — the `pulse.lock` holder pid —
before the pidStart-pinned spawn record. The lock token is `pid:hex` —
no start time — so `pidAlive(lockPid)` is reuse-blind: a crashed
`bro watch --every` holder whose pid was recycled onto an unrelated
live process reads `live: true` forever, and the checkpoint never
rearms. Same shape as bro-t2jc1 on the spawn-record path (which got
the `pidStart` pin); the lock path never did. The identical unpinned
read sits in `daemonProbe` (`daemon.ts`) on `drive.lock`, in
`rigPulseLive` (`rig-pulse.ts`) on `rig-pulse.lock`, and in
`collectTicks` (`serve.ts`) which reports `drive.alive` off the same
lock.

## Design

Bound the holder check with the contender's own rule — `staleLock()`
from `@broject/core` filelock: a lock reads live only while its holder
pid is alive AND its heartbeat mtime is inside `LOCK_ABANDONED_MS`
(15 min). All three locks are held via `awaitFileLock`/`holdFileLock`,
which rewrites the mtime every `LOCK_HEARTBEAT_MS` (3 min), so a
genuinely live hold never reads stale; a dead holder's file ages out
within one abandoned window. A recycled pid can therefore mask a dead
pulse/daemon for at most that window — not forever.

Rejected alternative: extend the lock token to `pid:start:hex` and pin
identity end-to-end. More precise (detection in seconds, not minutes),
but it changes the token format every contender and reader parses —
`lockHolderPid`, `lockStealable`, the heartbeat re-link — for a probe
whose consumers already tolerate a bounded window. Revisit if the
window ever proves too wide.

`staleLock` is already `export`ed by `filelock.ts` (janitor's
`reapStaleLock` sibling); this adds it to the package index so
`@broject/cli` consumes the contender's rule instead of re-deriving it.

## Plan

- [ ] `packages/core/src/index.ts`: re-export `staleLock`
- [ ] `watch-pulse.ts` `pulseLive`, `rig-pulse.ts` `rigPulseLive`,
      `daemon.ts` `daemonProbe`, `serve.ts` `collectTicks`: holder
      reads live only while the lock is not `staleLock()`
- [ ] tests: live pid + mtime past the abandoned bound reads dead
      across all four probes

## Acceptance

- A `pulse.lock`/`drive.lock`/`rig-pulse.lock` left by a dead holder
  whose pid now names a live foreign process reads not-live once its
  mtime crosses the abandoned bound — the next checkpoint rearms.
- A live heartbeated holder is never reported dead (the heartbeat sits
  far under the bound).
