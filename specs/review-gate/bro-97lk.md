# bro-97lk — act wait: pending-watch marker for session-bound waits

## Problem

`bro act wait` (especially `--merge`) polls the PR gate inside a
session-bound process: when the agent's turn ends, the poll dies with it.
Retro sv-gt31 (sverka): the agent promised "will report when PR merges"
while `bro act wait --merge` ran in an exec-background shell tied to the
session; the shell died with the turn, the gate ran unwatched, and the
user found the PR still open. Nothing in the repo could see that a watch
had been promised and lost.

## Design

The bead offers a ladder — detached spawn (nohup/systemd-run/tmux), a
watcher-daemon, or at minimum a persisted "watch was pending on PR X"
marker. This spec takes the minimum rung deliberately: a marker cannot
keep the poll alive, but it turns a silent broken promise into a flagged
one at the next session start, which is where an agent can actually act
on it (`bro act status`, respawn the wait, or report). A detached spawn
would still need the same marker to be observable across sessions, so
this is the substrate either way.

- **Marker store** — `<git-common-dir>/bro/watches/`, one JSON file per
  running wait. The common dir (not the worktree's `.git`) so a watch
  started in one linked worktree is visible to sessions in every other.
- **`watchBegin(dir, w)`** — `waitForGate` drops a marker for the wait's
  lifetime: `{pr, link, pid, pidStart, merge, startedAt, timeoutMin}`.
  Filename is `pr-pid-random.json` — two concurrent waits on one PR each
  own their marker, so neither publish nor retire clobbers the other's.
  Write goes to `.tmp` then `renameSync` — a crash mid-write never
  leaves a partial marker. Before publishing, dead-pid markers for the
  same PR are retired (the new watch supersedes their stale promise);
  dead markers for other PRs stay so session start can still flag them.
- **`watchEnd(path)`** — removes the marker on settle, timeout, or
  throw. A watch that completes normally leaves no residue.
- **`listWatches(dir)`** — liveness per marker: `kill(pid, 0)` plus the
  watcher's `/proc/<pid>/stat` starttime (`pidStart`) so a reused pid
  doesn't read as a live watch. Unverifiable identity stays fail-open
  (alive). Malformed JSON, TTL-expired markers, `.retired` residue, and
  `.tmp` files old enough to be crash residue are pruned on the way
  through; a fresh `.tmp` is a publication in flight and is left alone.
  TTL is `max(24h, timeoutMin)` — the marker must outlive its own poll.
- **`watchRetire(file)`** — `renameSync` to `.retired` is the atomic
  claim: exactly one of two racing session starts wins, so a stale
  promise reports exactly once.
- **Connector surface** — the act connector's `sessionStart` lists
  watches *before* the awaited gate probe: watch lines are local fs
  only, so a slow network probe that blows the hook budget can't strand
  the stale-promise report. Dead pid →
  `stale act watch on <link>( — was set to merge on green) — the
  watching session died; check bro act status --pr N`, retired on
  report. Live pid → passive `act watch active on <link> (pid N)` —
  parallel work, not a broken promise.
- **Fail-open throughout** — no git dir, unwritable watches dir,
  unreadable marker, absent `/proc`: the wait still runs, the hook just
  has nothing to report. Marker plumbing must never break a poll.

## Out of scope / approximations

- The watch still dies with the session — the marker flags the broken
  promise, it does not resurrect the poll. A detached supervisor
  (`bro drive`-style daemon or nohup spawn) remains a valid later rung
  and would reuse this marker store for observability.
- pid→process identity relies on `/proc`; on platforms without it the
  liveness check is pid-only (fail-open, documented above).

## Plan

- [x] `act/pending-watch.ts`: `PendingWatch`, `watchBegin`, `watchEnd`,
      `watchRetire`, `listWatches`; unique marker paths, tmp+rename
      publish, `/proc` starttime identity, timeout-aware TTL
- [x] `act/wait.ts`: `waitForGate` accepts a `watch` option — begin on
      entry, end on every exit path
- [x] `act/connector.ts`: `sessionStart` reports stale watches first,
      live watches as passive context; atomic retire on report
- [x] `cli/act.ts`: `cmdWait` passes the marker payload (pr, link,
      merge flag, timeoutMin)
- [x] `pending-watch.test.ts`: publish/retire, prune paths (malformed,
      tmp residue, TTL), same-PR dead pid, pid-reuse identity, racing
      retire
- [x] `npm test` + typecheck, PR
