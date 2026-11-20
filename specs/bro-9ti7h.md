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
2. `readTailSlice(file, size - AGENT_ARCHIVE_KEEP_BYTES)` — bounded
   memory: only the tail is read, so a legacy multi-GB archive caps on
   its next write without a whole-file read.
3. Drop the slice's first line (possibly torn mid-row); when the tail
   holds no second line it is kept whole — an archive never truncates
   to empty while data remains (the janitor `capFile` edge rule).
4. `writePrivateFileSync(file, tail)` — truncate+write on the
   verified fd: the 0600 pin is repaired, O_NOFOLLOW refuses a
   swapped-in symlink, a foreign-owned file is refused — the cap
   inherits the archive's whole security posture instead of opening a
   plain path around it. In-place, no tmp+rename: no
   briefly-world-readable staging file and no inode swap under a
   follow reader.

**Fail-open** — the cap runs inside `record`'s existing try/catch; a
cap fault (or the append's own) is swallowed exactly like every other
archive failure: telemetry never fails a turn.

**Race posture** — one writer owns each archive path (the agent's own
process; the proxy archive is even pid-keyed). A concurrent appender
between the tail read and the truncate can lose a row — the same
bounded telemetry loss `capFile` documents, never corruption: all
writers append with O_APPEND, so post-cap writes land at the new EOF,
never a sparse hole.

## Non-goals

- Janitor `capLogs` changes — the writer-side cap makes its
  "self-cap" comment true as written.
- The bus ring (already bounded) and `.log`/`.stderr` bounds
  (janitor-owned).
- Reader changes — every consumer is already truncation-safe.

## Tests

- **Bounded under volume**: drive `agentTurnPlane` updates carrying
  fat rows past the cap — final size stays within
  `AGENT_ARCHIVE_MAX_BYTES` + one row, every line still parses, the
  newest marker rows survive, the oldest drop.
- **Legacy convergence**: pre-seed an archive past the bound — the
  first `record()` caps it to the newest whole lines.
- **Fail-open**: archive path planted as a directory — `update()`/
  `stop()`/`drain()` complete, the turn never sees the fs fault.
- **Readers**: `tailArchive` (the shared consumer pump) over a capped
  file returns parsed rows and a valid resume offset.
