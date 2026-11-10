# bro-l8c4f.2 — filelock: kill capture/restore — the lock is a directory

## Problem

`removeCaptured` (packages/core/src/filelock.ts) removes a lock by
`renameSync(lock, dest)`, verifies the captured instance, and on a
failed verify puts it back with `renameSync(dest, lock)`. Two POSIX
facts make this unsafe, and they are unfixable inside the file
primitive:

- rename **replaces** an existing destination — a restore after a
  failed verify silently overwrites a successor's fresh lock.
- Between capture and restore `lock` is **absent** — a contender
  legitimately acquires it while the captured instance's owner still
  believes it holds. Restoring then either clobbers the successor or
  leaves two processes inside the same critical section; not restoring
  orphans the captured owner.

Moving a live lock is the defect itself — no ordering of
capture→verify→restore is safe, so the primitive has to make "remove
only the instance I verified" expressible without a rename at all.
Every mutex on the primitive shares the hole: `agents.json.lock`
(registry read-modify-write), `drive.lock`/`loop.lock`/`pulse.lock`
singletons, the debt store's own copy of the same scheme
(`packages/debt/src/store.ts` has a second capture/restore
implementation).

## Design

`X.lock` becomes a **directory**. The scheme is proper-lockfile's
mkdir primitive hardened so removal is name-precise:

- **Acquire**: `mkdir(X.lock)` — atomic on every filesystem that
  supports directories (this is why the primitive needs neither
  `link(2)` nor the `wx` O_EXCL fallback: both are deleted). The holder
  then publishes `X.lock/h-<pid>` — an entry whose **name is the
  ownership proof** — and verifies `stat(X.lock).ino` still names the
  dir it created. A publish that landed in a foreign dir (its own
  freshly-created dir was swept mid-publish) unlinks its stray and
  retries.
- **The core invariant**: `rmdir` refuses a non-empty directory.
  Once an entry exists inside `X.lock`, no actor can make the `lock`
  name go absent or rebind — the instance at `lock` is pinned while
  occupied, which is exactly what a lock file could never guarantee.
- **Release**: verify `lstat(X.lock).ino === hold.dirIno` FIRST, then
  `unlink(X.lock/h-<pid>)` + `rmdir(X.lock)`. The inode check must
  lead because `h-<pid>` is per-process — a re-acquired successor can
  legitimately carry the same entry name, and unlink-before-verify
  would strip it. The release closure also gates on
  `heldLocks.get(lock) === hold`, so a stale closure is a no-op: it
  can never strip a re-acquired hold under a matching name.
- **Steal / reap**: `readdir` → every `h-<pid>` entry carries its
  owner in the name — no file read, no capture. The judged dir is
  **pinned by inode for the whole steal**: each entry's inode is
  recorded at scan and re-checked before its unlink (a heartbeat
  re-publish is a new inode under the same name → a pass, not a
  strip), and `lock`'s dir-inode is re-validated before every removal
  and before `rmdir` — a mid-steal swap to a successor instance stops
  the steal outright. The steal then ends in `rmdir` — conditional on
  empty, so a concurrent publish aborts instead of being clobbered.
  A live owner whose entry was stolen under the abandoned bound
  re-publishes via its heartbeat, making the stealer's rmdir fail —
  self-healing. `stealDir` reports "the judged instance is gone", so
  the janitor never counts a survivor as reaped.
- **Symlinks are never followed**: every shape check is `lstat` — a
  symlinked `X.lock` classifies as neither dir nor file, so steal/
  release/reap can never descend a link into an unrelated directory
  and delete its contents. The janitor classifies by `lstat` too.
- **Legacy files**: an `X.lock` that is a regular file (created by a
  pre-change binary or a hand-rolled hold) is still honored — a live
  token blocks; a dead one is pinned by a `link(2)` probe (while
  pinned the inode cannot recycle, so an inode match at `lock` IS the
  verified instance), re-verified, and dropped by **compare-then-
  `unlink`** — no rename at all: `unlink(2)` refuses directories, so
  a dir-lock successor that lands mid-steal cannot be captured. On
  filesystems without `link(2)` the same compare-then-unlink runs
  unpinned — the documented degradation leaves only a stat→unlink
  gap, and a dir successor is still unreachable.
- **fs faults are not contention**: only ENOENT/ENOTDIR inside an
  acquire attempt mean "the instance moved" and retry; real fs errors
  (EACCES, ENOSPC, EROFS…) clean up our own instance and throw —
  `LockTimeout` never mislabels a broken filesystem, and
  `awaitFileLock` never retries one forever.
- **Stale rules unchanged**: liveness is the staleness signal
  (dead pid → steal at once), the abandoned bound still bounds a live
  hold (15 min), and a fresh empty dir is an in-flight publisher —
  wait, never break (the old empty-FILE grace becomes an empty-DIR
  grace).
- **`heldLocks`**: the re-entrancy map records `{entry, dirIno,
  token}` — release, heartbeat, and the stale-closure gate consult it.
- **Heartbeat**: re-asserts the entry and freshens the dir mtime on
  its own inode; after every publish it re-verifies the dir inode and
  pulls its entry back out if `lock` swapped to a successor mid-beat,
  so a stray name never blocks a foreign instance.

A second copy of the buggy scheme lives in
`packages/debt/src/store.ts` (`acquireFileLock`/`releaseFileLock`/
`stealLock` local to that package) — it migrates onto the fixed core
primitive in the same change; its `<path>.lock` is already a dir.

## Plan

- [x] `packages/core/src/filelock.ts`: dir-lock acquire/publish/verify,
  inode-pinned release/steal/reap, lstat-only classification,
  heartbeat on dir inode, legacy-file read/steal path; delete
  `removeCaptured`, the `wx` fallback, and every rename in steal
  paths; keep `sweepStaged` for pre-change `.tmp` debris.
- [x] `packages/core/src/janitor.ts`: `*.lock` sweep accepts
  directories (dead-entry reaping + empty-dir reap), keeps
  legacy-file reaping, classifies by `lstat`.
- [x] `packages/debt/src/store.ts`: drop the local capture/restore
  lock, use `withFileLock`/`acquireFileLock` from `@broject/core`.
- [x] `packages/core/src/filelock.test.ts`: rewrite around the dir
  primitive + deterministic multi-process barrier tests;
  `syncBuiltinESMExports`-propagated fs patches for the fallback
  tests.
- [x] `packages/core/src/janitor.test.ts`: dir-lock reap rows.

## Acceptance

Deterministic multi-process tests with real barrier files between the
old race's steps (stale precheck, successor publish, mid-steal gap,
release of a stolen hold):

- **Max one owner**: N spawned contenders serialize — the critical-
  section log shows strict enter/exit pairing.
- **A foreign live token is never moved or overwritten**: a live
  `h-<pid>` entry and its dir survive a contender's steal attempt and
  a timed-out acquire byte-for-byte (inode + contents).
- **The successor gap is safe**: dead entry → stealer unlinks it →
  successor publishes into/behind the gap → whoever owns `lock`
  afterward is the only holder; the loser's release cannot touch the
  winner's entry.
- **Release of a stolen hold**: owner's dir stolen and re-acquired by
  a successor; the old owner's release removes nothing of the
  successor's.
- **Abandoned-bound self-heal**: a live heartbeated hold whose entry
  is stolen re-publishes; the stealer's `rmdir` fails ENOTEMPTY.
- **Real POSIX fs + fallback**: tmpdir tests exercise the normal
  path; a simulated no-`link(2)` run proves dir acquire/steal never
  need hardlinks (legacy files take the documented degraded path).
- Exact repo CI (`npm run build`, `npm run typecheck`, `npm test`)
  green; `bro spec check` sees this file.
