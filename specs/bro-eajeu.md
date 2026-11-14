# bro-eajeu — test hermeticity: repo runtime state resolves through `stateCommonDir` (`BRO_STATE_DIR` pin)

## Problem

`npm test` running inside a linked worktree (every `bro--<bead>`
checkout) resolves `gitCommonDir(process.cwd())` to the MAIN
checkout's `.git`. Any test that drives a session/conductor path with
an ambient cwd therefore appends to the operator's LIVE
`<git-common>/bro` state:

- `serve-conductor-{cooldown,deadloop,idle}.test.ts` —
  `cfg.cwd: process.cwd()` → `conductorProxy` pins
  `otelJournal(<common>/bro/serve-turns.jsonl)` → every `otelEvent` in
  the process writes to the live journal (819 `dv-acp` rows observed
  in one day).
- `acp-agent.test.ts` e2e — `session/new` `cwd: process.cwd()` → the
  proxy's `agentTurnPlane({plane: 'proxy'})` archives to
  `<common>/bro/proxy/acp-<sid>-p<pid>.events.jsonl` (fixture reply
  `AGENT-SAYS-HI` found in the live dir).
- the same `agentTurnPlane`/`busSocketPath` resolution publishes
  'agent' bus events onto the live repo's broker socket whenever cwd
  resolves there (today a no-op only because no broker listens).

The shared-worktree resolution itself is correct production behavior —
linked worktrees must share `<git-common>/bro`. The bug is that tests
have no seam to redirect the state root away from a real checkout.

## Design

`stateCommonDir(dir, timeoutMs?)` + `stateCommonDirAsync` in
`@broject/core` (git.ts, next to `gitCommonDir`) — the resolver every
`<git-common>/bro` runtime-state surface shares:

- `$BRO_STATE_DIR` set → the pin (resolved absolute) stands in for the
  git common dir — state lands at `$BRO_STATE_DIR/bro/...`. Follows
  the `BRO_HOOK_SPOOL`/`BRO_DEBT_DIR` env-pin convention: an
  operator/harness-facing override, not a test-only hack.
- `$BRO_STATE_DIR=0` → `null` ("no repo" — every caller already treats
  that as "no state home").
- unset → `gitCommonDir(dir)` unchanged — production resolves the real
  common dir exactly as today. `gitCommonDir` itself is untouched:
  real git-dir consumers (worktree ops, locks) never see the pin.

Surfaces converted (the leak paths the bead names + their transport):

- `acp-events.ts` — `agentTurnPlane` and `agentEventRecord` archive
  resolution (`bro/proxy/*`, `bro/agents/*`).
- `bus.ts` — `busSocketPath`/`busStatePath` (the socket hash and the
  discovery doc move with the pin, so a pinned suite's publishes and
  brokers share one sandbox namespace).
- `serve-conductor.ts` — the `otelJournal` pin.
- `act` — `watchesDir`/`watchesDirAsync` (pending-watch) and the
  act-state cache root (`prStateCache`).

Remaining `<common>/bro` writers (agents.json, lifecycle events,
notify, serve.json, hooks/*) are reachable only through explicit
fixture dirs today; they migrate to `stateCommonDir` as tests surface
them — the helper is the documented pattern going forward.

The leaking suites pin `BRO_STATE_DIR` to a `mkdtemp` at module top
(same posture as their `BRO_TELEMETRY=0` lines) — `cwd: process.cwd()`
stays realistic, the pin makes it hermetic. acp-agent's e2e asserts
the proxy archive lands under the pin.

## Verify

- new sentinel tests fail before the fix: a worktree-shaped fixture
  (main repo + linked worktree) + `BRO_STATE_DIR` pin →
  `agentTurnPlane` proxy/agents rows and the conductor's
  `serve-turns.jsonl` land under the pin, `main/.git/bro` never
  appears.
- `stateCommonDir` unit coverage in git.test.ts (pin → resolve,
  `0` → null, unset → `gitCommonDir` answer incl. linked worktree).
- targeted suites green: core git, providers acp-events/acp-worker/
  acp-proxy/acp, cli acp-agent + serve-conductor*.
- `npm test` in a worktree appends nothing to the main checkout's
  `.git/bro/serve-turns.jsonl` / `proxy/` (mtime + line count before
  and after).
