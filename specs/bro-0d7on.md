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
