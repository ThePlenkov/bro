# bro-izpyk.1.1 — fleet F1a: spool row enrichment + LedgerFacade + lazy node:sqlite worker draining hooks.spool

Child of bro-izpyk.1 (spec `specs/sessions/bro-izpyk.md` on PR #700's branch
`devin/1792972271-fleet-spec` — the epic contract source; cited below as "epic
spec"). **Write path only** — `bro sessions`, `bro fleet board`, and the doctor
rows are sibling beads bro-izpyk.1.2/.1.3 and are explicitly out of scope.

## Problem

The Tier-0 spool writer (`hooks/run.sh` `hook_spool_start`/`hook_spool_end`)
records only `v1 ts phase id host event cwd rc outcome`. The epic spec's ledger
needs the native session id, pid/ppid, adapter version, launcher, and plugin
root per firing, and host detection covers only cursor|devin|claude — codex
(`PLUGIN_ROOT`) and every other host record `unknown`. Two whole classes of
fires are invisible today:

- the shell **fast path** (`post-tool`/`prompt-submit` exiting before Node)
  writes no spool rows at all — in observe-mode steady state that is most
  events, so the ledger would see a session only on its rare Node-bound
  events;
- in-process adapters (opencode, kilo, pi, omp) spawn `bro hooks` directly and
  bypass `run.sh` — filed as a follow-up, not this bead.

And nothing drains the spool: no `LedgerFacade` contract exists in
`FacadeMap`, and no `node:sqlite` ledger.db exists to receive rows.

## Design

### 1. Spool format v2 (`hooks/run.sh`)

Bump the wire version to `v2` with a wider row. Both phases share one prefix;
`cwd` stays last so embedded tabs survive (readers re-join the tail):

```
start: v2 <ts> start <id> <host> <sid> <event> <pid> <ppid> <agent> <adapter> <proot> <launcher> <cwd>
end:   v2 <ts> end   <id> <host> <sid> <event> <pid> <ppid> <agent> <adapter> <proot> <launcher> <rc> <outcome> <cwd>
```

- `sid` — native session id, first `session_id`/`conversation_id` string in
  the payload (empty when absent). Requires capturing stdin to a temp file for
  every event — gated on spool-enabled (`BRO_HOOK_SPOOL != 0`) and non-tty
  stdin, reusing the existing `CAPTURED`/`PAYLOAD_FILE` feed so Node still
  reads identical bytes. Spool-disabled launches keep today's zero-capture
  path.
- `pid`/`ppid` — `$$`/`$PPID` of the launcher.
- `agent` — `BRO_AGENT_ID` when bro spawned the session (feeds
  `sessions.spawned_by`).
- `adapter` — plugin manifest `version` probed once per launch under
  `SCRIPT_ROOT` (`plugin.json`, `.cursor-plugin/`, `.claude-plugin/`,
  `.codex-plugin/`, `.devin-plugin/`, repo-root `plugin.json`); empty when no
  manifest resolves.
- `proot` — `SCRIPT_ROOT` (the plugin root).
- `launcher` — `agent` (BRO_AGENT_ID set) | `herdr` | `tmux` | `zellij` |
  `screen` | `ssh` | `interactive`, from env only, no forks.
- `host` — widened: `*_PLUGIN_ROOT` vars first (cursor, devin, claude), then
  `*_PROJECT_DIR` corroboration, then bare `PLUGIN_ROOT` → `codex` (the repo's
  existing convention — `readCodexInstructions`/`doctor` treat it the same),
  then a payload fingerprint (`turn_id` → codex, `cursor_version`/
  `workspace_roots` → cursor) only when env detection failed, else `unknown`.
- outcome vocabulary stays the v1 set **plus `fastpath`**: the shell fast-path
  exit now writes a start+end pair with `outcome=fastpath` before `exit 0`.
  Canonical ledger outcomes (`timeout|killed|error`) are produced by the
  worker's mapping, not the writer — `bro hooks status` keeps its columns.

The spool function block moves above the fast-path `case` so both paths can
write; identity fields are computed once per launch and cached.

### 2. Version-tolerant reader (`packages/cli/src/commands/hook-spool.ts`)

Row parsing moves to `packages/core/src/hook-spool.ts` as
`parseSpoolLine()` — one canonical v1+v2 parser both the aggregate reader and
the ledger worker share (no drift). `readHookSpool` keeps its aggregate
contract; `HookOutcome` widens to the full token set and aggregation buckets
canonical aliases (`timeout`→watchdog, `error`→nonzero, `killed`→killed) while
`fastpath` gets its own count + column. `cwd` for v2 is `fields.slice(13|15)
.join('\t')`.

### 3. LedgerFacade + ClaimFacade contracts (core)

Per epic spec `core/src/ledger.ts` / `core/src/claims.ts`:

```ts
interface LedgerFacade {
  append(rows: LedgerRow[]): Promise<void>
  sessions(q?: SessionQuery): Promise<SessionRow[]>
  installs(): Promise<InstallRow[]>
  stats(q?: StatsQuery): Promise<HookStat[]>
  setMode(s: SessionKey, mode: Mode): Promise<void>
}
interface ClaimFacade {
  claim(r: ResourceUri, s: SessionKey, o?: { ttlMs?: number; exclusive?: boolean }): Promise<ClaimResult>
  release(r: ResourceUri, s: SessionKey): Promise<void>
  list(q?: ClaimQuery): Promise<ClaimRow[]>
}
```

`Mode = observe|plan|code|review|orchestrate`; `SessionKey = {host, sid}`.
`FacadeMap` gains `ledger` + `claims`; `Connector` gains optional `ledger()`/
`claims()`; `facade()` dispatch + `plugins.ts` `FACADE_KEYS`/
`CONNECTOR_FUNCTION_KEYS` updated. A built-in `ledger` connector (registered
beside beads/git) serves the sqlite backend — the designed default, not
opt-in. `claims` has **no provider yet** (bro-izpyk.3 owns claim semantics);
`facade('claims')` throws the honest "no connector provides" until then.

### 4. Lazy worker — `node:sqlite` ledger.db

`packages/core/src/ledger-store.ts` — `$XDG_STATE_HOME/bro/ledger.db`,
`DatabaseSync` via dynamic `import('node:sqlite')` (Node 22.x flag compat,
same pattern as `packages/devin/src/usage.ts`), WAL mode. **Lazy**: no
resident process — `drainHookSpool()` runs on invocation; the facade's read
methods opportunistically drain pending rows first (size/ino check makes the
no-op case sub-ms). Wired into `bro hooks status` (the existing cheap cadence
that already reads the spool) via `await` before render; exported for the
F1b read surfaces.

Schema = epic spec tables (`installs`, `sessions`, `events`, `claims`,
`hook_stats_daily`) + `meta` (cursor) — with two documented deviations:
`events.pair` (the run.sh launch id — needed to compute `ms` for end rows and
to dedup synthesized kills) and `events.row_hash` is *not* used; dedup is the
cursor's job.

- **Cursor**: `meta.spool_cursor` = JSON `{ino: byteOffset}` per spool file
  (`hooks.spool.1` then `hooks.spool`). Inode-keyed so rotation
  (`hooks.spool`→`.1`, fresh `hooks.spool`) resumes correctly; `size < offset`
  resets to 0. Only complete lines ingest — a partial tail line holds the
  offset back for the next pass.
- **Ingest**: spool outcome → canonical (`watchdog`→`timeout`,
  `nonzero`→`error`, others verbatim); `ms` = end−start via in-batch pair map
  then `events.pair` lookup; sessions upsert per `(host,sid)` with project
  (`projectId(cwd)`, realpath fallback), branch, cwd, pid, `pid_start`
  (best-effort `ps`), `spawned_by`=`agent`, `state='live'`, `last_seen`;
  installs upsert per `(host, plugin_root)` keeping latest adapter version.
- **Killed synthesis**: start events older than `now − (watchdog + 5s)` with
  no end pair and no existing killed row get a synthetic `phase=end,
  outcome=killed` event — the spec's "firing but killed" signal, deduped by
  `pair` inside the write transaction.
- **Stats rollup**: `hook_stats_daily` recomputed per affected UTC day from
  end-phase rows (n, p50, p95 over `ms`, timeouts, errors).
- **Retention**: events >14d and stats >180d deleted per spec; WAL checkpoint
  after each drain. `claims` table created empty — F3 fills it.

Timestamps: spool `ts` is epoch **seconds**; the ledger stores **ms**
(converted at ingest). `day` keys are UTC dates.

## Non-goals

- `bro sessions` / `bro fleet board` / doctor rows (bro-izpyk.1.2/.1.3).
- Claim semantics, leases, arming/occupancy migration (bro-izpyk.3).
- In-process adapter spool writes (opencode/kilo/pi/omp bypass run.sh) —
  follow-up bead.
- `plane.history()` backfill, launchers, remote ledger (bro-izpyk.5).

## Tests (hermetic)

- `core/hook-spool.test.ts` — v1 + v2 line parsing, malformed rows, cwd
  re-join.
- `cli/hook-spool.test.ts` — v1/v2/mixed aggregation, `fastpath` bucket,
  canonical-alias tolerance.
- `core/ledger-store.test.ts` — fixture spool files → drain → ledger rows;
  idempotent re-ingest; cursor advance/rotation; killed synthesis; stats
  rollup; retention prune.
- `hooks.e2e.test.ts` — `assertSpoolCase` updated for v2 field positions;
  existing dash+bash matrix keeps passing.
