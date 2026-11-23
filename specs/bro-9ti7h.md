# bro-9ti7h — acp event archive self-cap

## Problem

Deferred from PR #655 (sourcery, PRRT_kwDOUamqtM6vqcsy): the ACP
turn-plane archives — `<common>/bro/agents/<agentId>.events.jsonl` and
`<common>/bro/proxy/acp-<sid>-p<pid>.events.jsonl` — grow without
bound. `record()` in `packages/providers/src/acp-events.ts` appends a
full-fidelity row for every session/update (per-chunk text deltas
included) plus `agentEventRecord`'s out-of-band rows, and nothing ever
removes one. A long or high-volume session — exactly the shape the
proxy and a busy worker produce — grows its per-session archive
indefinitely.

The janitor does not cover the gap: `capLogs` bounds `.log`/`.stderr`
of live agents only, and its own comment claims `events.jsonl` files
"self-cap inside their append lock" — the bound this spec installs.
Archives in the wild are already oversized, so the cap must also
converge a pre-existing giant file on its next write without reading
it whole.

## Design

**Scheme — truncate-to-newest-tail, self-capped in the writer.** The
repo's journal convention (lifecycle `compactLifecycle`, otel file
sink, janitor `capFile`): append, then when the file outgrows the byte
ceiling, keep the newest whole lines. A `.1`/`.2` rotation splits one
logical archive across files every consumer would have to chain;
truncation keeps the single-path contract every reader already has —
and every reader is already truncation-safe (`tailWindow` skips a
torn head, `readTailSlice` consumers resync their offset with
`Math.min(offset, size)`, `followLog` reports truncation and rides
remove/reopen, serve's `readLogTail` reads a bounded tail).

**Bounds** — `AGENT_ARCHIVE_MAX_BYTES = 4 MiB`, keep the newest
`AGENT_ARCHIVE_KEEP_BYTES = 2 MiB`: the lifecycle journal's pair. The
archive is the durable record behind a windowed reader (64 KiB
`TAIL_BYTES` open), so 2 MiB of tail is far past any consumer's
scrollback while the file stays small enough to copy/read cheaply.

**One append seam** — `appendArchiveRow(file, line)`: the private
append plus the cap check, called by both writers (`record()` inside
`agentTurnPlane` — covering the `agents` and `proxy` scopes — and
`agentEventRecord`), so every write path inherits the bound.

**Cap step** (`capArchive`), after each append:

1. `sizeOf(file) <= AGENT_ARCHIVE_MAX_BYTES` → no-op (one statSync per
   row, the otel sink's exact shape — proportional next to the
   open/write/close the append already pays).
2. Read the tail through ONE `O_RDONLY | O_NOFOLLOW` fd — a path
   swapped to a symlink is refused like the write seam refuses it,
   and the open pins the instance so a racing resize reads honest
   offsets. The read runs to the fd's own EOF, not the first stat's:
   rows appended mid-cap land inside the kept tail instead of being
   renamed away (bounded — a runaway appender stretches the read by
   at most one extra MAX). Bounded memory throughout — a
   pre-existing giant archive converges on its next write without a
   whole-file read.
3. Keep only complete JSONL rows — the slice's first line can be
   torn mid-row and drops; no newline at all means the tail is one
   unparseable fragment (a row bigger than the keep window): dead
   weight, not data — the archive converges to empty and grows
   fresh rows.
4. Replace via a staged private write + atomic rename
   (`<file>.cap-<pid>` → `<file>`): the archive is never empty or
   partial — a kill mid-cap leaves the OLD file whole or the NEW
   one, never a truncated middle (an in-place truncate+write can't
   say that). No consumer holds the archive's fd — every reader
   opens per poll — so the inode swap strands nothing; the staged
   file is pinned 0600 by the same seam as the append, and a stale
   `.cap-<pid>` is bounded 0600 debris. A swapped-in symlink AT the
   archive path is itself replaced by the rename — the cap restores
   the real file.

**Fail-open** — the cap runs inside `record`'s existing try/catch; a
cap fault (or the append's own) is swallowed exactly like every other
archive failure: telemetry never fails a turn.

**Reader resync** — one consumer needed a real fix: `pumpEvents`
(`herdr-kit`) kept its saved offset past a truncated EOF, so post-cap
appends were skipped until the file regrew past it. It now resyncs
`min(offset, size)` on an empty slice — the `pumpLog` posture it was
already meant to mirror. Every other consumer is already
truncation-safe (`tailWindow` skips a torn head, `followLog` reports
truncation and rides remove/reopen, serve's `readLogTail` is bounded
per request).

**Race posture** — one writer owns each archive path (the agent's own
process; the proxy archive is even pid-keyed). The read-to-EOF loop
captures appends that land mid-read; an append landing between the
last read and the rename loses a row — the same bounded telemetry
loss `capFile` documents, never corruption: all writers append with
O_APPEND, so post-cap writes land at the new EOF, never a sparse
hole.

## Non-goals

- Janitor `capLogs` changes — the writer-side cap makes its
  "self-cap" comment true as written.
- The bus ring (already bounded) and `.log`/`.stderr` bounds
  (janitor-owned).
- Cross-process append/cap locking — same-agentId concurrency is
  outside the archive's ownership model; the read-to-EOF window
  already shrinks the residual loss to microseconds of telemetry.

## Tests

- **Bounded under volume**: drive `agentTurnPlane` updates carrying
  fat rows past the cap — final size stays within
  `AGENT_ARCHIVE_MAX_BYTES` + one row, every line still parses, the
  newest marker rows survive, the oldest drop, and a lower bound on
  retained rows rules out an over-truncating cap.
- **Proxy scope**: the `bro/proxy/` archive (the bead's named
  surface) self-caps identically.
- **Legacy convergence**: pre-seed an archive past the bound — the
  first `record()` caps it to the newest whole lines, seeded rows
  survive in bulk, and the file stays owner-only.
- **Oversized row**: a single row bigger than the keep window leaves
  no unparseable fragment — every retained line is complete.
- **Fail-open**: archive path planted as a directory — `update()`/
  `stop()`/`drain()` complete, the turn never sees the fs fault.
- **Readers**: `tailArchive` (the shared consumer pump) over a capped
  file returns parsed rows and a valid resume offset; `pumpEvents`
  resyncs a saved offset that outlives a cap (pumpLog parity — the
  closure has no test seam, the mirror is line-for-line).
