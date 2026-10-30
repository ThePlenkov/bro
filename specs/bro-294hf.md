# bro-294hf — bus: worker/worktree lifecycle events — agent spawn/exit + worktree add/remove on abstract topics

## Problem

Every consumer of worker/worktree state is a polling engine: the fleet
view re-reads `agents.json`, watch re-stats loop logs, a facade plugin
would have to poll both plus `git worktree list`. The lifecycle journal
(`emitLifecycle`, specs/telemetry/bro-ub91h.md) already records the real
transitions — `spawn`, `agent-exit`, `worktree` — but it is a file:
append-only, no subscribers, no filters. The local bus (bus.ts) exists
precisely to carry these facts on topics with subscriber-side filters —
yet nothing publishes lifecycle transitions onto it, so an external
facade (plugins/herdr LiveSource, bro-8dbyb) has nothing to subscribe to.

## Design

- **One seam: `emitLifecycle` is the feed's single writer.** It is
  already "the ONLY writer every surface shares" for the journal — the
  spawn admission (`recordSpawnClaim`), the exit harvest
  (`ensureExitCause`), and every worktree add/remove
  (`work enter`/`leave`/`cleanup`, drive fixer trees, the loop's stack
  trees) funnel through it. Mapping the journal row to a bus envelope
  inside `emitLifecycle` covers every call site — and every future one —
  instead of chasing ~10 emit sites with per-site publish calls.
- **Transport: `busPublish` direct, never `facade('events')`.** The
  facade's default connector is the session _mailbox_ — publishing
  there would drop a notify file per transition into live sessions
  (fleet-wide spawn/exit spam in session context). The bus is the
  opt-in observational plane: broker down resolves `published:false`,
  and the publish is fire-and-forget (`void …catch`), matching the
  mailbox→bus dual-write precedent (events-connectors.ts `notify`
  topic). No NATS, no herdr coupling — cross-rig fan-out is the ymswu
  connector's job; core stays consumer-agnostic.
- **Envelope** (the `topic`/`kind`/`key`/`ref`/`payload` contract of
  `publishRetroEvent`/act/convoy/drive):
  - `worker.spawned` — topic `worker`, kind `spawned`, key agentId,
    ref worktree, payload `{agentId, runId?, bead?, worktree, log,
    backend?, provider?, model?, class?}`. Emitted from the `spawn`
    journal row; the row's `detail` gains `runId`/`log` (honest fields
    the registry write already has — the journal was simply not told).
  - `worker.exited` — kind `exited`, key agentId, ref log, payload
    `{agentId, runId?, bead?, code, cause, backend?}` from the
    `agent-exit` row (detail gains `runId`/`log`).
  - `worker.silent` — kind `silent`, key agentId (beadId fallback),
    ref log, payload `{agentId?, bead, silentMin}`. **No journal
    row** — silence is a derived level, not a recorded transition. It
    rides the _existing_ silence computation in `bro watch`'s tick
    (`loopPlane`/`loopAttention`): a per-process Set detects the
    loud→silent crossing so a run emits once per silent stretch, and a
    run that speaks again re-arms. No new poller is invented — the
    `--every` cadence is the existing heartbeat.
  - `worktree.added` / `worktree.removed` — topic `worktree`, key +
    ref the path, payload `{path, branch?, bead?}`. `to: 'removed'`
    maps to `removed`; `created`/`reused` map to `added`.
  - `source` carries the journal row's `detail.via` (agents/work/
    drive/cleanup/loop), `watch` for worker.silent. The lifecycle `to`
    field (target _state_) is deliberately NOT mapped to the envelope
    `to` (recipient _address_) — mapping it would hide every event
    behind a phantom address.
- **Fail-open everywhere.** `emitLifecycle` already swallows all
  faults; the bus mirror adds no new failure path. A wedged broker
  resolves inside `BUS_TIMEOUT_MS`, and `void`-firing keeps the publish
  off the command path.
- **One git probe, not two.** `busSocketPathForCommon(common)` (new
  export, factored out of `busSocketPath`) lets `emitLifecycle` reuse
  the common dir it already resolved for the journal path.

## Plan

- [x] `bus.ts`: factor `busSocketPathForCommon(common)` out of
  `busSocketPath`; export it.
- [x] `packages/core/src/lifecycle-bus.ts` (new): `lifecycleBusEvent`
  (journal row → `EventInput | undefined`), `publishLifecycleBusEvent`
  (common + row → fire-and-forget publish), `emitWorkerSilent` (dir +
  {bead, agentId?, silentMin, log?} → worker.silent).
- [x] `lifecycle.ts`: `emitLifecycle` resolves the common dir once
  (instead of `lifecyclePath`'s internal probe), mirrors the row to the
  bus after the append.
- [x] `agent-connectors.ts`: `recordSpawnClaim` takes runId/log into
  the `spawn` detail; `ensureExitCause` adds `runId`/`log` to the
  `agent-exit` detail.
- [x] `watch.ts`: shared `silentRunMin` predicate (reused by
  `loopAttention`), per-tick transition set → `emitWorkerSilent`,
  agentId resolved best-effort via `readAgentRegistry`.
- [x] `lifecycle-bus.test.ts`: mapper unit tests + fixture integration
  (broker on the derived socket inside a `git init` tmpdir —
  `withRepo`/`withBroker` conventions): emitLifecycle rows arrive as
  envelopes; broker-down emits resolve; emitWorkerSilent lands.
- [x] `npm run typecheck`; `tsx --test` on the touched suites.
