# bro-2hno — local event bus: topics, filters, fan-out, seq cursors

## Problem

Every consumer of agent state in bro is a polling engine, and three of
them re-implement subscription semantics independently:

- `bro watch` diffs a rendered snapshot against `lastNotified`
  (`packages/cli/src/commands/watch.ts:460-472`)
- the notify drain tracks per-session `.seen-*` cursor files
  (`packages/core/src/notify.ts`)
- the hook probe walks shared directories on every event

So one-to-many, many-to-many and per-subscriber filters exist nowhere, and
N consumers polling M sources is the shape that keeps failing. The shared
directory is also why 83 orphaned `.seen-*` cursors exist as of
2026-10-04: per-session state with no owner and no expiry.

What a shared directory cannot give at all is a **total order**. 83
separate cursor files have no global sequence, so "which fixer finished
before which" is unrecoverable — exactly the causality an orchestrator
needs when it decides what to respawn.

Two candidate sources were rejected on their own merits:

- **devin MCP** (`devin_session_events`, `devin_session_gather`,
  `devin_session_interact`) is pull-only by construction: they are tools,
  callable only from inside an agent turn, and only by the agent that owns
  the ACP session. A host-side bro process cannot reach them at all. The
  first revision of this bead proposed a zero-inference bridge over them,
  which is impossible by construction rather than merely inefficient.
- **Poll cost.** The contention argument for dropping files is not real at
  this workload: roughly one event per agent exit, ~25/hour at eight
  agents, and atomic rename does not lock. The strong reason is
  subscription semantics, and that is what this spec builds.

## Design

A broker process on a Unix domain socket in the repo-common dir. Zero
dependencies, `node:net`, newline-delimited JSON, one envelope per line:

```json
{"seq":41,"ts":"2026-10-04T12:00:00.000Z","topic":"agent","kind":"failed","key":"bro-7xgk.2","source":"wrapper","payload":{}}
```

- **`seq` is the cursor.** Monotonic per broker run, assigned under the
  single-threaded server loop. A consumer reconnects with its last `seq`
  and receives what it missed.
- **Replay ring.** The broker keeps the last `RING_LIMIT` envelopes
  (default 10 000). A consumer asking for a `seq` still inside the ring
  gets the tail from there; older than the ring, it gets a single
  `gap` marker and must re-derive state from the registry, which stays
  the source of truth. Durable per-agent JSONL is **not** the delivery
  path — the ring plus the registry is enough, and a delivery path that
  needs its own compaction is the debris this design refuses to create.
- **Filters are subscriber-side.** `{topics, kinds}` with trailing-`*`
  glob on topic. Matching happens once, in the broker: one publish, N
  subscribers, each receiving only its subset. This is the capability the
  three hand-rolled pollers each lack.
- **Ephemeral publishers.** `bro bus publish` connects, writes one line,
  exits. No long-lived connection is ever required of an agent — the only
  component that must stay connected is a host-side subscriber, because
  the only receiver inside a live Devin session is the host-side
  `postTool` probe.
- **Addressability.** `sun_path` is capped at 108 bytes on Linux and 104
  on macOS; a deep worktree path truncates silently into `EADDRINUSE`.
  The socket path is therefore `join(tmpdir(), bro-bus-<hash>.sock)` where
  the hash is over the absolute git-common dir, so it is short and stable
  per repo regardless of path depth.
- **No supervision.** The server starts on demand and publishes
  `<git-common>/bro/bus.json` (same discovery shape as `serve.json`).
  A client that finds the socket already bound connects instead of
  binding; the `EADDRINUSE` path is the normal path, not an error.

### Non-negotiable: fail open

`REVIEW.md` rates any path that can hang or `exit 1` on a hook event as a
**critical** finding. So:

- the client carries a hard budget — `BUS_TIMEOUT_MS`, default 2000 for
  `publish`, and the probe path uses a shorter one — and resolves "nothing
  to report" on expiry rather than throwing
- connection-refused is an ordinary empty result, never an error
- `bro bus status` reports `down` and exits 0; only a real protocol fault
  is an error
- a broker restart loses nothing durable: subscribers fall back to
  registry polling

### Out of scope for this PR

- wiring the broker into the `postTool` probe — the critical fail-open
  path gets its own PR and its own test that the probe never stalls
- `bro watch` / `bro drive` migrating off their pollers
- durable audit log (deferred to `bro-f6zp` janitor, which owns retention)
- removal of the 83 existing `.seen-*` cursors (janitor bead)

## Plan

- [x] `packages/core/src/bus.ts` — envelope, filter match, ring buffer,
      broker server, client, socket path, fail-open probe helper
- [x] core barrel export
- [x] `packages/cli/src/commands/bus.ts` — `serve` / `publish` /
      `subscribe` / `status` verbs
- [x] plugin registry entry (`skill` omitted — the skill ships with the
      hook integration, not before)
- [x] tests: filter matching, ring eviction + `gap` marker, two
      subscribers with different filters from one publish, reconnect
      replay from `seq`, broker-down fail-open, socket-path length
- [x] retention on all three axes — count, `ttlMs`, `maxBytes` — plus a
      drop watermark so an aged-out ring reads as a `gap`, never as an
      empty list
- [x] `cause` / `ref` in the envelope from day one (offsets belong in
      the envelope, or every later transport change is a migration)
- [x] acceptance: broker restart degrades to `gap` + re-derive, and a
      probe that stalls is asserted against both a down broker and a
      broker that accepts and never answers
- [ ] hook probe integration (separate PR)
- [ ] `bro watch` / `bro drive` migrate to subscriptions (separate PR)

## Transport, not capability — the facade layer is the next PR

This PR ships a **transport**. `busPublish` / `busSubscribe` / `busProbe`
are hardwired to `connect(socketPath)`, so the choice of transport is
baked into every caller.

The repo already has the abstraction that fixes this, and the broker was
built to its shape rather than around it:

- **facade** `events` — the capability, named by domain semantics, never
  by vendor (`packages/core/src/connectors.ts:45`). Its contract is
  exactly `publish` / `subscribe(filter, {since})` / `probe`, which is
  what this PR already exposes.
- **connectors** — `mailbox` (today's `notify`: the file drop plus a
  per-session `.seen-<sid>` cursor) and `bus` (this PR). `mqtt` / `amqp`
  join when the fleet goes multi-host, which the bead already predicts.
- **config** — `"connectors": { "events": "bus" }`, resolved by the
  existing precedence at `connectors.ts:315`.

Two constraints the next PR must hold:

1. **`mailbox` stays the default.** `bro notify` works with zero setup
   today, and that is its most valuable property. Defaulting `events` to
   `bus` would make `notify` depend on a running daemon — a regression
   traded for flexibility nobody asked for. The broker is opt-in.
2. **`notify`'s CLI and on-disk layout must not change.** Only the
   transport underneath moves; otherwise the migration breaks scripts
   that already parse its output.

That the facade joins "only when a real consumer exists"
(`connectors.ts:20-21`) is what makes this the right moment: `notify` is
the existing consumer, and until it moves, the broker has no user but its
own tests. `bro watch` / `bro drive` follow once `events` is the path
they use.

## Deviation from the bead: the log is not truth here

The bead's transport note requires that "the log is truth and the
transport is only a wakeup hint — a missed notification must never mean
a missed event". This implementation does not do that, and the deviation
is deliberate rather than overlooked:

- the replay window is **memory-only**. A broker restart loses every
  event a consumer had not yet replayed.
- what makes that safe is that **the registry stays the source of
  truth**. A consumer that loses an event gets a `gap` and re-derives
  from the registry, which is exactly the fallback the bead's own
  "broker restart degrades to registry polling" criterion asks for. The
  bus is a latency and admission-control optimisation, never the
  durable record.

What this costs, stated plainly: a consumer can miss an event while the
broker is down, so anything that must not be lost cannot be bus-only.
Durable per-agent JSONL remains audit, not the delivery path. If a
future requirement makes "no missed event" absolute, this becomes an
append-only log with the bus as its wakeup hint — which is why `seq`,
`cause` and `ref` are already in the envelope.
