# bro-0d7on — devin session locks: verify the pid is still devin, not just alive

## Problem

The devin session plane reads `<name>.lock` files under
`~/.local/share/devin/cli/session_locks`, parses the recorded pid, and
counts the session live when `pidAlive(pid)` holds. The lock records
ONLY the pid — no starttime — so the pid-reuse arm of `pidAlive` never
engages: after a reboot or a SIGKILLed session, the lock outlives the
process, the pid gets recycled by an unrelated process, and the plane
counts a phantom forever.

Observed live: `bro agents status` reported 11/6 devin sessions while
`/proc` showed `devin:veil-uniform` (pid 975) = `snapfuse`,
`devin:whimsical-matrix` (pid 1048) = `snapfuse`, `devin:achieved-replace`
(pid 2140) = `herdr server`. Three phantom rows held the quota hostage —
`bro agents run` refused every spawn at a saturated count that was
structurally incapable of draining (the locks are foreign-owned; nothing
reaps them).

## Design — identity check on the pid, not just liveness

`liveDevinLockPids` gains a second predicate: on a host with `/proc`,
the live pid's `cmdline` must identify the devin CLI — argv[0] basename
`devin*` (versioned binary, `devin acp`, `devin -p`, interactive `devin`)
or any argv element inside a `/devin/` install path (node/bun launching
the CLI script). A live pid that is verifiably NOT devin is a recycled
pid: the lock is stale, the session is not counted.

Fail directions, consistent with the file's existing contracts:

- **cmdline unreadable / empty on a /proc host** → not counted. A real
  devin session runs same-uid — its cmdline is always readable; an
  unreadable one belongs to a foreign-uid recycler (the observed
  phantoms were root-owned snapfuse/herdr). Undercounting a real
  session over-admits once; counting a phantom starves the pool
  permanently — starvation is the worse failure.
- **procDir absent entirely (macOS)** → identity check skipped,
  `pidAlive` only — the pre-change behaviour is preserved; a probe that
  cannot exist must not invent either answer.

`procDir` threads through `countDevinSessions`, `countDevinWorkers`,
`listDevinSessions` (test injection, same convention as the existing
`agents.devin.procDir` bag override — now wired into `countLive` /
`countWorkers` too, not just `listLive`).

The lock file itself is NOT deleted — foreign state, devin's own
lifecycle owns it; the plane just stops counting it.

## Phase 2 — pin the pid's start against the lock's own write bound

The comm check landed as `isDevinProcess` and the bead stayed open for
a reason: it answers "is this pid still devin?" but not "is this pid
still THE devin the lock named?". The lock records only a pid — no
starttime — so two phantoms survive it:

- a pid recycled into ANOTHER devin-named process. bro-q0v0e made this
  the common case: 147 `acp.spawn`s churned 147 short-lived devin pids
  through `bro serve`; each `session/new` + `devin rm` respawns the
  devin binary, so a dead session's lock pid is far more likely to land
  on `devin acp`/`devin rm`/`devin usage` than on snapfuse — argv[0]
  `devin` and not a session.
- a pid whose `/proc/<pid>/cmdline` is unreadable (foreign uid,
  non-dumpable setuid mounts): `isDevinProcess` cannot disprove
  identity and counts it — the file's fail-closed contract, applied to
  a phantom.

The t2jc1 fix pins a recorded pid against its `/proc` starttime; bro's
own markers carry `pid + pidStart` for exactly this. Devin's lock
carries no starttime — but the writer already recorded the bound: a
lock can only name a pid that existed when it was written, so for a
genuine lock `procStart <= lastWrite` always holds. A pid whose
`/proc/<pid>/stat` starttime postdates the lock's last change by more
than a small slew is a different process wearing the number — stale,
not counted. `/proc/<pid>/stat` stays world-readable where `cmdline`/
`environ` are not (verified on this host's root-owned snapfuse mounts:
`cmdline` 0444 too, `environ` 0400 — `stat` answers for all of them).

The bound is `min(mtime, ctime)` of the lock file — the earliest stamp
the pid content could have been written at (a `chmod` refreshes ctime
without touching the write bound; a copied-in file keeps its mtime).
Slew tolerance `LOCK_PID_SKEW_MS = 60_000`: observed on this host
2026-11-13, two live `devin --resume` sessions whose acp-child pids
started ~1.2–1.8 s *after* their lock's mtime (the resume write/child
race plus an early-boot RTC step — the jiffies→epoch conversion anchors
on `os.uptime()`). A recycled pid is minutes to whole boot cycles
late, never seconds — 60 s kills every phantom the quota chokes on and
never touches a real session.

Fail directions, same contract as the comm check: unreadable lock
`stat`, absent `/proc` or unreadable pid `stat` → the pin cannot be
established, the pid counts (a probe that cannot answer invents no
staleness). A proven-stale lock is only skipped, never deleted.

Scope: `lockIsLiveSession` is the single seam — `countDevinSessions`,
`countDevinWorkers`, `countDevinBatchWorkers`, `listDevinSessions`
(`bro agents status --connector devin`) and `devinExternalActivity`
all read through `liveDevinLocks`, so the pin lands once. Other
planes checked: opencode's external probe scans `/proc` by argv
directly (no file-bound pid, different shape, no quota lane — left);
the markers plane already pins `pid + start`; copilot counts via the
vendor API.

## Tests — `session-planes/devin.test.ts`

- `devinPidIsSession`: scripted cmdline `devin acp` → true; `snapfuse` /
  `herdr server` → false; `/devin/cli/…` script path → true; missing
  cmdline → false.
- `countDevinSessions`: live pid + non-devin cmdline → not counted
  (the phantom case); devin cmdline → counted; procDir absent →
  counted (fail-open preserved).
- `countDevinWorkers` / `listDevinSessions`: phantom drops from worker
  count and from rows.
- Existing tests updated: scripted /proc entries now carry `cmdline`
  (default `devin acp\0` in `mk`); real-pid tests inject the fake
  procDir instead of relying on the test process's own cmdline.
- Phase 2 (`plane.test.ts`, scripted `procDir` + `utimesSync`-aged
  locks): a devin-argv0 pid whose starttime postdates the lock's last
  change by > 60 s → not counted (same-comm recycle); start inside the
  skew bound → counted; absent pid `stat` → counted (fail-open);
  `listDevinSessions` drops the stale row identically.
