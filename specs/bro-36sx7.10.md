---

parent: bro-36sx7
scope:
- packages/core/src/notify.ts
- packages/core/src/notify.test.ts

---

# bro-36sx7.10 — notify: cheap mailbox drain (mtime check, single cursor, GC)

## Problem

The notify connector's `postTool`/`sessionStart` probe drains the
mailbox on **every** hook event (`core/src/notify.ts`). Each drain pays
a full synchronous scan of the mailbox dir:

- `readdirSync` + `lstatSync` + `readFileSync` per drop
  (`drainDir`/`drainDrop`), even when nothing changed since the last
  drain — O(number of pending drops) per post-tool.
- a per-session `.seen-<sid>` cursor file, rewritten on every drain
  (`writeSeen`) — one file per session that ever drained, never
  consolidated; the comms spec counted 83 orphaned cursors.
- `readSeen`'s per-drain cursor read and `pruneStaleCursors`' stat per
  `.seen-*` file scale with session count, not drop count.

The mailbox is a broadcast plane: most drains find zero new drops, so
the common case should cost O(1), not O(drops).

## Design

**One cursor file per mailbox: `.cursors`.** A single JSON document
inside the mailbox dir holds every session's cursor plus the dir
stat the session last scanned against:

```json
{ "sessions": { "<sid>": { "seen": ["drop.txt", ...], "touched": <ms>,
    "sig": "u:{...}", "dirMtimeMs": <ms>, "dirCtimeMs": <ms> } } }
```

- `seen` keeps today's semantics — drop names the session has been
  shown, pruned to names still on disk on every write (the old
  `writeSeen` self-limit).
- `touched` is the session-GC clock (below); `sig`/`dirMtimeMs`/
  `dirCtimeMs` drive the fast path.
- Session keys are the **raw** sessionId (JSON keys need no
  sanitization — the old `[\w.-]` filename mangling could collide two
  distinct sids onto one `.seen-*` file; the map cannot).
- The file is written **in place** (`writeFileSync`, no tmp+rename):
  a rename would add/remove a dir entry and bump the mailbox's own
  mtime — the very signal the fast path reads. An in-place write of an
  existing file never touches dir mtime. Merge-on-write (re-read,
  overlay this session's entry, GC stale sessions, write) shrinks the
  lost-update window between concurrent drains to the re-read→write
  gap; a lost update only ever redelivers, never loses.

**mtime check before `readdirSync`.** `drainDir` first `statSync`s the
mailbox dir — one syscall. When the session's recorded
`dirMtimeMs`+`dirCtimeMs` still match, no entry was created, removed,
or renamed since that session's last identical drain, and drops are
immutable once renamed (the tmp+rename write protocol), so nothing
deliverable can exist: return `[]` without `readdirSync`, without
per-drop stats, and without a cursor write. `ctime` rides along as a
second change signal at zero cost.

The fast path is gated on an **opts signature** (`sig`): it applies
only to keep-less drains (`opts.keep === undefined` — the notify
connector's hook path) whose `for` identity serializes identically.
A `keep`-filtered drain (the events plane's subscribe/probe) can
reject drops the hook drain would deliver, so it always takes the
slow path and records `sig: "k"` — which can never match a `u:`
signature, forcing the next keep-less drain to rescan and pick up
whatever the filter left pending. Same `for`, different keep ⇒ never
a false skip; different `for` ⇒ different sig ⇒ rescan.

Correctness notes:

- The recorded baseline is the **pre-scan** stat. A drop landing
  between stat and readdir is scanned *and* leaves the recorded
  baseline stale, so the next drain rescans once and finds it already
  seen — the conservative direction, never a miss.
- Deferred GC is the point: expired drops and stale cursors reap on
  the next *changed* drain (and the janitor's `sweepMailbox` already
  reaps expired `.txt`/`.tmp`/`.seen-*` on `bro watch` ticks for
  mailboxes nobody drains). An unchanged dir has nothing deliverable
  anyway — TTL only ever removes.
- First drain per mailbox creates `.cursors`, bumping dir mtime once
  → exactly one extra scan, then stable (in-place writes don't move
  it).

**GC.** On the slow path, after the scan:

- session entries with `now - touched > SEEN_TTL_MS` (7d, same scale
  as the old cursor TTL) are dropped from `.cursors` — dead sessions
  stop accumulating state;
- a legacy `.seen-<sid>` file, when present, is imported into the
  session's `seen` set and removed — pre-upgrade cursors keep their
  dedup exactly, and the 83-file pattern stops growing (other
  sessions' legacy files stay for the janitor's existing `.seen-*`
  sweep or their own next drain);
- `seen` is pruned to names still on disk, as `writeSeen` did.

`pruneStaleCursors`/`writeSeen` are replaced; `seenPath`/`readSeen`
survive for the legacy import. `peekMailbox`, `coalesceDrops`, and
the planes/events lister are untouched — they are not the per-postTool
hot path (peek must read every drop's bytes to render; coalesce must
read every drop to match identity; neither can skip on mtime alone).

## Tests

- repeat drain writes nothing: after stabilizing, an `utimesSync`'d
  `.cursors` mtime stays put across an empty drain (a slow-path drain
  always rewrites it);
- legacy `.seen-<sid>` import: honored names stay delivered=never,
  file removed, `.cursors` written;
- one `.cursors` file serves multiple sessions, no `.seen-*` created;
- stale session entries GC on write; live ones survive;
- existing drain semantics (order, broadcast, addressed, TTL, keep)
  unchanged — the whole existing suite runs against the new cursor.
