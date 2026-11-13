# bro-izpyk.9 — fleet F1a follow-up: in-process adapters emit into the hook spool

Child of bro-izpyk (epic contract `specs/sessions/bro-izpyk.md` on branch
`devin/1792972271-fleet-spec` — the SessionPlane sketch and the ledger
sections; write path specs/bro-izpyk.1.1.md via PR #1006, read surfaces
specs/bro-izpyk.1.2.md via PR #1017, doctor rows specs/bro-izpyk.1.3.md).
This is the "adapter-spool follow-up" both 1.1 and 1.3 defer to.

## Problem

The epic's core promise is *one ledger for every agent session on the
machine*, but the client adapters that run hooks **in-process** never touch
`hooks/run.sh` — they spawn `bro hooks <event>` directly
(`packages/agent-plugins/{opencode,kilo,pi,omp}`). run.sh owns the Tier-0
spool writer, so these sessions write no rows: `bro sessions` can't see an
opencode session standing right next to a claude one, the ledger's
installs/sessions/events/stats tables are blind to four whole hosts, and
`hookHostOf` resolves `unknown` for every adapter firing — mode files,
inbox names, and claim rows would all record the wrong host even if a row
landed. Doctor only papers over this: `ledgerAdaptersCheck` reports the
blind set as a permanent skip row.

## Design

The adapters already pay a Node spawn per event — the seam is inside
`bro hooks` itself, so emission costs **zero extra process starts** and the
hot path stays Node-free exactly where the spec demands (run.sh hosts
unchanged). Direct `LedgerFacade.append` is rejected: it makes every hook
spawn a concurrent writer on ledger.db and duplicates or bypasses the
spool ingest pipeline (killed synthesis, stats rollup, session upserts).
Emitting the same **v2 spool wire format** keeps the drain the single
writer and gets every downstream surface for free.

### 1. The marker: `BRO_HOOK_HOST` (+ optional `BRO_HOOK_ADAPTER`, `BRO_HOOK_PROOT`)

An adapter stamps env on the `bro hooks` spawn it already makes:

| var | meaning |
| --- | --- |
| `BRO_HOOK_HOST` | the ledger host name (`opencode`/`kilo`/`pi`/`omp`) — presence marks the launch as a direct in-process adapter call |
| `BRO_HOOK_ADAPTER` | adapter version → `installs.adapter_version` (from the adapter's npx pin where one exists) |
| `BRO_HOOK_PROOT` | adapter's own plugin dir → `installs.plugin_root` |

Rollout is safe in both directions: old adapters don't stamp (status quo,
no rows), new adapters + old CLI are ignored env, and run.sh hosts can
never produce the marker — no double-write path exists.

`hookHostOf` honors `BRO_HOOK_HOST` FIRST (slug-validated): the adapter's
claim of identity is stronger than `*_PLUGIN_ROOT` inference, and it makes
mode files (`sessions/opencode-<sid>.mode`), F4 inbox names, claims, and
ctx.host agree with the ledger host for free.

### 2. `SessionPlane.detectHook` + `normalizeHook` (epic spec sketch lands)

`packages/core/src/session-planes.ts` gains the optional members the epic
spec sketched (only `resumeArgv` landed in F4):

```ts
interface SessionPlane {
  // …existing members…
  detectHook?(env: NodeJS.ProcessEnv): boolean;          // is this hook invocation mine?
  normalizeHook?(payload: unknown): CanonicalHookEvent;  // host payload → canonical fields
}
interface CanonicalHookEvent { sid?: string; event?: string; tool?: string; cwd?: string }
```

`detectHook(env)` for an in-process plane is `env.BRO_HOOK_HOST === kind`.
`normalizeHook` extracts the canonical session id (`session_id` /
`conversation_id` / host-native keys) — today every adapter already sends
`session_id`, so the shared normalizer is one function; the member exists
so a host whose payload spells identity differently owns its own mapping.

`packages/cli/src/session-planes/adapters.ts` registers minimal planes for
`opencode`/`kilo`/`pi`/`omp` — the same deliberately-degenerate shape as
`session-planes/resume.ts` (`detectsCli` false, `countLive` throws
'unavailable'), merge-into-existing so either import order preserves
opencode's `resumeArgv` plane.

### 3. Node-side spool writer (core `hook-spool.ts`)

`formatSpoolRow(row: SpoolRow)` renders the v1/v2 TSV the parser reads —
wire emission lives beside `parseSpoolLine` so the contract can't drift.
`appendHookSpoolRows(rows, env)` resolves `BRO_HOOK_SPOOL`/`XDG_STATE_HOME`
through the existing `resolveHookSpoolPath`, mkdirs, and appends — always
fail-open (`BRO_HOOK_SPOOL=0` and an unwritable dir both no-op).

### 4. Emit inside `runHooksCommand` (`hook-emit.ts`)

`adapterEmitBegin(event, raw, input, env)`:

- returns a no-op emit unless a registered plane's `detectHook` matches —
  run.sh hosts produce no `BRO_HOOK_HOST`, so their cost is one map scan;
- returns a no-op when `BRO_HOOKS=0` and event ≠ `permission` — run.sh's
  early-exit parity (those launches were never journaled);
- writes the v2 **start** row: `id = pid-t0`, `host` = plane kind, `sid` =
  `normalizeHook(raw).sid ?? input.session_id`, `pid`/`ppid` =
  `process.pid`/`process.ppid` (the hooks process = run.sh's `$$`; its
  parent = the plugin host — identical shape), `agent` = `BRO_AGENT_ID`,
  `adapter`/`proot` = the env vars, `launcher` = the same env derivation
  run.sh runs, `cwd` = `process.cwd()` (the adapter's spawn dir — captured
  before `enterHookProject` may chdir).

`emit.end(rc, outcome)` writes the matching **end** row once (first write
wins): `ok` on normal completion, `fastpath` on the `BRO_HOOKS=0`/
`!broEnabled` early returns, `error` when dispatch threw, `watchdog` in
the deadline timer before `process.exit`. A host kill leaves a start with
no end — the worker's existing killed synthesis covers it unchanged.

Placement: after `runPreGateCommand` and the bare-probe return (operator
commands never journal), after `readRaw` + `prepareHookInput` (the sid
needs the payload). Guarded by `try/finally` so every exit pairs its
start.

### 5. Adapter stamps

- `adapter-core` (`callHook`): gains a spawn-env param; `sharedBinding`
  builds `hookEnv` from `BroHostShape.kind` + `npxPin` (version →
  `BRO_HOOK_ADAPTER`) + the module's own dir → `BRO_HOOK_PROOT`. `pi.ts`
  passes `kind: 'pi'`, `omp.ts` `kind: 'omp'` — one field each.
- `opencode.ts`: stamps the same env in its own `callHook` copy.
- `kilo.ts`: stamps `BRO_HOOK_HOST`/`BRO_HOOK_PROOT` in `runBroHook` (no
  npx pin exists there — `BRO_HOOK_ADAPTER` stays absent).

### 6. `ledger-adapters` un-skips per coverage

The check reads the installed artifact(s) (`pluginRows` paths — file or
bundle dir contents) for the `BRO_HOOK_HOST` literal: presence proves the
installed copy emits. Verdicts:

- no adapters installed → `skip` (unchanged);
- every installed adapter emits → `ok` — names them as ledger-visible;
- any installed adapter lacking the marker → `warn` naming the blind set —
  actionable now (reinstall/upgrade), no longer a permanent skip.

## Non-goals

- run.sh hosts (claude/codex/cursor/devin) — their spool path is
  unchanged; nothing here re-tiers the shell writer.
- `LedgerFacade.append` from the hook path — rejected (concurrent writers,
  bypassed ingest); the spool stays the single ingest contract.
- `plane.history()` backfill, launcher facades, remote ledger (F5).
- Mode activation for adapters beyond what `hookHostOf` honoring the
  marker already gives (mode files/bind work once a session exists).
- `BRO_HOOK_INPUT` (kilo's pre-existing, unread marker) stays as-is.

## Tests

- `core/hook-spool.test.ts` — `formatSpoolRow` v1+v2 round-trips through
  `parseSpoolLine`; field sanitization; `appendHookSpoolRows` honors
  `BRO_HOOK_SPOOL=0`/pin/XDG.
- `core/session-planes.test.ts` — `detectHook`/`normalizeHook` members,
  shared normalizer's key coverage.
- `cli/session-planes/adapters` — registration merge preserves existing
  plane members (opencode `resumeArgv`), `detectHook` marker semantics.
- `cli` hook-emit unit + e2e — `bro hooks <event>` with
  `BRO_HOOK_HOST=pi` + `BRO_HOOK_SPOOL` writes a v2 start/end pair
  (host, sid, pid, `ok`); `!broEnabled` → `fastpath`; `BRO_HOOKS=0` → no
  rows; no marker → no rows.
- `doctor.test.ts` — marker-bearing artifact → ok row; stale artifact →
  warn naming it; none installed → skip.
