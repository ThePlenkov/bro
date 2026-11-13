# bro-74y7n — the devin identity probe on a host without /proc

## Problem

`lockIsLiveSession` (bro-0d7on) verifies a devin session lock three ways:
the pid is alive (`pidAlive` — already portable), the pid is still the
devin CLI (`isDevinProcess` — `/proc/<pid>/cmdline`), and the pid's
starttime does not postdate the lock's write bound (`procStartMs` —
`/proc/<pid>/stat` field 22).

On a host without `/proc` (macOS) the /proc reads cannot run, and both
verdicts fail open: an unreadable identity "counts", an unverifiable
starttime "counts". The stale-lock protections exist there only on
paper — a recycled pid (the tailscaled phantom of bro-0d7on, the
devin-on-devin churn of bro-q0v0e) counts as a live session forever,
exactly the bug the pins fixed on Linux.

## Design — the same two facts, answered by `ps`

A host without `procDir` answers the same two questions over
`ps -p <pid> -o lstart=,command=`:

- **identity** — `command` is the space-joined argv vector; argv[0]'s
  basename is the exact identity `/proc/<pid>/cmdline` carries
  (`argv0 === 'devin'` is a live devin session; any other name is a
  recycled pid and the lock is stale). `comm` was considered and
  rejected: it names the RESOLVED binary, which a symlinked install, a
  multicall copy, or a process that renames its own comm (node's
  `node-MainThread`) all spell differently than the invoked name —
  `command=`/`args=` is the faithful cmdline equivalent. A spaced
  argv[0] path arrives pre-split; `psTokenize`/`psRegroupPaths` (core's
  own darwin-argv convention, doctor's `darwinArgv`) re-glues the
  fragments an `existsSync` boundary proves.
- **starttime** — `lstart` (4 or 5 tokens, year optional) `Date.parse`s
  to the start epoch the write-bound pin compares. `LC_ALL`/`LC_TIME` are
  pinned `C` so the month spelling parses on any locale; `TZ` stays
  unpinned so `lstart` renders in the same zone `Date.parse` interprets —
  the conventions `live-procs.ts`'s darwin scan already runs.

The probe is one `execFileSync` per pid, injectable as `psProbe` through
`countDevinSessions` / `countDevinWorkers` / `countDevinBatchWorkers` /
`listDevinSessions` — the same test-injection convention `procDir`
carries. A present `procDir` takes the /proc path verbatim: scripted
trees keep every existing test's semantics, and nothing about the Linux
count changes.

## Fail directions — the count's contract does not move

The count fails closed on doubt, exactly as the /proc reads do:

- **ps cannot run at all** (spawn failure, nonzero exit — a live pid ps
  fails to match is indistinguishable from a ps that cannot run) →
  identity unverifiable → **counted**. A nonzero exit is never "gone":
  only a clean run answering no row proves the pid dead.
- **ps ran, no row for the pid** → the pid is gone → stale lock →
  **not counted**.
- **row present but unparseable** (no Date.parse-able lstart prefix, an
  empty argv remainder) → identity unverifiable → **counted**; `startMs`
  stays undefined and the write-bound pin fails open like an absent
  `/proc/<pid>/stat`.
- **argv[0] named and not `devin`** → proven stale → **not counted**.
- **zombie** — already screened by `pidAlive` (`procStat`'s `ps -o
  state=` 'Z' check on darwin) before the identity probe runs.

`ps` sits beside `pidAlive`/`kill(0)` on the portability floor: it is
POSIX, present on every host the plane runs on, and where it cannot run
(/proc-less Linux) the verdict is the same fail-open the file already
holds — the count is no worse than today, never worse than /proc gave.

## Still unverifiable on a no-/proc host — honest degraded mode

The fallback answers ONLY the liveness/identity chain inside
`lockIsLiveSession`. The remaining /proc facts have no portable spelling
wired here and keep their undercount contracts:

- `environ` probes (`devinPidIsWorker`'s BRO_AGENT_ID / BRO_HOOKS badges,
  `devinPidIsBatch`'s BRO_BATCH, `devinPidIsOwned`, `sweepLandedSlots`,
  `devinPidAgentId` / `devinPidBead`) → unreadable → not a worker / not
  owned / no landing sweep. `countDevinWorkers` and
  `countDevinBatchWorkers` therefore keep **refusing** with
  `SpawnError('unavailable')` when live sessions exist and `procDir` is
  absent — the worker/batch caps stay unsupported (fail-closed) on a
  no-/proc host; the session cap becomes enforceable.
- `fd/0` stdin and `tty_nr` worker probes, `/proc/<pid>/cwd`
  (`devinPidCwd`) → undefined → interactive-leaning defaults.

`ps eww` env reads and `lsof` cwd/stdin probes are the known extensions
if a darwin host ever needs the worker lanes — deliberately out of scope.
