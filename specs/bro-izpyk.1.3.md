# bro-izpyk.1.3 — fleet F1c: doctor rows — installed-but-silent / firing-but-killed / ledger freshness

Child of bro-izpyk.1 (epic contract `specs/sessions/bro-izpyk.md` on branch
`devin/1792972271-fleet-spec`, "Visibility"; landed write path
specs/bro-izpyk.1.1.md via PR #1006, read surfaces specs/bro-izpyk.1.2.md via
PR #1017). **Doctor probes only** — no ledger-store, spool-format, or
read-surface changes beyond two export widenings noted below.

## Problem

F1a/F1b made every manifest-host hook firing visible in the session ledger,
and `bro sessions` / `bro fleet hosts` surface it — but a broken install is
still silent: the ledger only learns a host BY firing, so a wired-but-dead
plugin, hosts killing hooks past the watchdog, and a spool that outgrows its
drains all look identical to "nothing happened". The epic spec's doctor list:

- **installed but silent** — an adapter is present but there have been no
  events for N days;
- **firing but killed** — start lines without end lines (host kills);
- **duplicate wiring** — already owned by `hooks-wiring` (bro-36sx7.5),
  unchanged here.

The bead adds a fourth ledger-health row the spec implies:

- **ledger freshness** — `hooks.spool` grows while the ledger ingest cursor
  stalls → the lazy drain isn't running (worker not draining).

## Design

Three new `DoctorCheck` rows appended by `sessionLedgerChecks(dir, deps)` —
an async collector `runDoctorCommand` awaits after the synchronous
`runDoctorChecks` pass (facade reads are async; `runDoctorChecks` and every
existing test stay sync). Order inside the collector is deliberate:
**freshness first** — the ingest cursor must be read before any facade read
opportunistically drains the spool, or the backlog measurement would see
post-drain state.

Data sources, per the bead: `readHookSpool`/`resolveHookSpoolPath` for
spool-side stats; `facade('ledger')` (`installs()`/`sessions()`/`stats()`)
for ledger rows — the same read path `bro sessions`/`bro fleet hosts` use,
no SQL duplicated. The drain cursor is not on `LedgerFacade` by design
(read commands never see the ingest surface), so freshness opens the store
once via `openLedgerStore(ledgerDbPath(env))` + `loadCursor()` — guarded by
`existsSync` so a missing db is never created by a probe.

### 1. `ledger-silent` — installed-but-silent

**Wiring evidence** (`wiredHosts`, fail-open — unreadable/missing → not
wired, never an error):

| host | probes |
| --- | --- |
| claude | `<CLAUDE_CONFIG_DIR\|~/.claude>/plugins/installed_plugins.json` `plugins` keys `bro@*`; `.claude/settings{,.local}.json` (user config dir + repo root) carrying the bro launcher signature `hooks/run.sh` / `bro hooks` |
| devin | plugin lockfile `resolved[].name === 'bro'` (existing `devinPluginLockfile`/`broPluginResolved`); repo `.devin/hooks.v1.json` carrying the same signature |
| cursor | `~/.cursor/plugins/` bro entries (`bro`, `local/bro`, one-level `*/bro`); repo `.cursor/hooks.json` signature |
| codex | `<CODEX_HOME\|~/.codex>/plugins/` bro entries, same shape |
| any | ledger `installs()` rows — a past firing is itself wiring proof (covers hosts whose on-disk layout the probes don't know) |

**Silence verdict** — per wired host, `lastActivity = max(install.lastSeen,
session.lastSeen, stats day-end)`; silent when it is older than
`HOST_QUIET_MS` (7 d, reused from fleet-hosts — the board's own silent
bucket) or the host has wiring but zero ledger rows at all. One warn row
lists every silent host with its evidence; ok row when all wired hosts
fired inside the window (or none are wired).

**Client adapters excluded, reported separately.** opencode/kilo/pi/omp
install through `bro plugins install` (`pluginRows`) but spawn `bro hooks`
directly — they bypass `run.sh` and write no spool rows, so the ledger is
blind to them *by design* until the adapter-spool follow-up lands
(specs/bro-izpyk.1.1.md non-goals). Warning "installed but silent" on them
would be a permanent false positive; instead a `skip` row
(`ledger-adapters`) names the installed-but-ledger-blind adapters — the
honest answer to "why doesn't `bro sessions` show my opencode session".

### 2. `ledger-killed` — firing-but-killed

`readHookSpool(spool, { sinceMs: now − 24h, watchdogSeconds: env
BRO_HOOK_WATCHDOG_S })` — the same window and watchdog `bro hooks status`
uses. Sum `row.killed` (start rows with no end past watchdog + grace, per
host×event) across the window; warn when the total reaches
`LEDGER_KILLED_WARN_MIN = 3` — one stray kill (host restart mid-hook,
laptop sleep) is noise, a pattern is the signal. Detail names the count and
the worst host×event pair. Ok row at zero.

### 3. `ledger-drain` — ledger freshness

- `pendingBytes` = Σ over `hookSpoolFiles(spool)` of `size − offset`,
  where `offset = cursor[spoolCursorKey(stat)] ?? 0` — bytes appended
  since the last ingest, per file (`.1` rotated rows and the live file
  both count; a missing cursor entry means the file's inode was never
  ingested → its full size is pending). Cursor-reset rule, shared with
  `readBatches`: when the file's size falls below the stored offset
  (truncated or recreated under the same `ino:birthtime` key), the
  offset resets to 0 and the entire file counts as pending — the value
  is `size − (size < offset ? 0 : offset)`, never a `max(0, …)` clamp
  that would report a shrunken file as fully consumed.
  `spoolCursorKey` (`ino:birthtimeMs`) is exported from core so the key
  computation can't drift from the store's.
- `ledgerAge` = `now − max(mtime of ledger.db, ledger.db-wal)` — the wal
  matters because `append()` writes frames without a checkpoint.
- warn when `pendingBytes ≥ MAX_SPOOL_BYTES/4` (256 KiB of the 1 MiB
  rotation bound — a backlog that size is not a lazy-drain transient) AND
  `ledgerAge ≥ 24h` (the ledger hasn't been written in a day while rows
  pile up). Missing `ledger.db` counts as infinite age — a big spool with
  no ledger is the extreme case of "worker not draining". Ok row reports
  the pending byte count; skip when spooling is disabled or no spool
  file exists.

### 4. Fail-open contract

Every probe degrades to `skip`, never `fail`, never a throw: missing
spool/ledger, absent `node:sqlite`, unwritable state dir, unparseable
plugin manifests — all skip rows with the reason in `detail`. Doctor's
"read-only" contract is preserved in spirit: the only writes are the
ledger's own lazy drain (identical to what `bro sessions` does on read)
and sqlite's WAL/schema no-ops on an existing db; probes never create
`ledger.db` (`existsSync` guard) and never create state outside
`$XDG_STATE_HOME/bro/`.

## Non-goals

- Duplicate-wiring detection — `hooks-wiring` owns it.
- Client-adapter spool writes (opencode/kilo/pi/omp bypass run.sh) — the
  F1a follow-up bead; `ledger-adapters` only reports the gap.
- A resident `bro fleet worker` — drains stay lazy/on-read; this bead only
  measures whether they're keeping up.
- Per-session kill attribution or resume — F4 scope.

## Tests (hermetic, `doctor.test.ts`)

`sessionLedgerChecks(dir, { env, ledger, now })` with fixture env
(`XDG_STATE_HOME`/`BRO_HOOK_SPOOL`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/
`XDG_DATA_HOME`/`HOME` pinned into the tmpdir), a real `ledgerFacade`
backed by a tmp `ledger.db` for row content, and an all-rejecting stub
for the fail-open case; freshness tests build a real `ledger.db` via
`openLedgerStore` and hand-write spool lines. Verdicts:

- silent: wired host (claude `installed_plugins.json`, devin lockfile,
  project `.devin/hooks.v1.json`) + zero rows → warn; same host with a
  fresh `lastSeen` → ok; no wiring anywhere → ok.
- killed: fixture spool with paired ends + an unpaired start past the
  watchdog → warn at ≥3, ok below; missing spool → skip.
- drain: pending bytes ≥ threshold + stale db → warn; fresh db or small
  backlog → ok; no db + big spool → warn; `BRO_HOOK_SPOOL=0` → skip.
- fail-open: ledger facade throwing → skip rows, never a rejection.
