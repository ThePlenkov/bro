---
parent: bro-u8i3h
scope:
- packages/providers/src/acp-worker.test.ts
- specs/bro-u8i3h.md
---

# bro-u8i3h — npm test leaks ambient global config (~/.config/bro)

## Problem

`npm test` on a machine with a populated `~/.config/bro/` must be green;
the host's operator config is not a test input. Two leak channels exist,
and each needed its own cut:

**Channel 1 — the config layer (fixed by #844, verified green).**
`loadConfig` merges `$XDG_CONFIG_HOME/bro/config.{ts,json}` over the
project file, so suites expecting an empty provider registry saw the
host's entries (`devin-acp`, `devin`, `kilo`), and `serve.backend`
resolved the host's `devin-acp` lane that `conductorConfig` then
rejected against the fixture's provider map. PR #844 pinned
`XDG_CONFIG_HOME` to an empty tmp inside `scrubEnv()` and armed it in
`providers.test.ts`, `config.test.ts`, `config-schema.test.ts`, and
`serve-conductor.test.ts`. Re-verified on a host with a real global
config: all green.

**Channel 2 — `provider.env` arms the otel emit queue (this spec).**
`packages/providers/src/otel.ts` `ENDPOINT()` falls back to
`~/.config/bro/provider.env` (hardcoded `homedir()` path — the
`XDG_CONFIG_HOME` pin cannot cut it) when the env var is unset. On a
host where that file carries `OTEL_EXPORTER_OTLP_ENDPOINT`, two test
defects follow:

- **Pollution.** Every `otelSpan`/`otelEvent` in a test process enqueues
  and drains to the operator's real collector — `acp-worker.test.ts`
  calls `runAcpWorker` (which opens `otelSpan('acp.open')`) in most of
  its 28 tests, all POSTing to the host's OTLP sink.
- **Cross-trace flake.** `enqueue` drops a span only when NO endpoint
  resolves; `emit()` resolves `ENDPOINT()` fresh at drain (deliberate —
  "a mid-life env repoint still moves the ambient lane"). When the
  trace test pins `OTEL_EXPORTER_OTLP_ENDPOINT` to its loopback
  collector, the next drain ships spans enqueued by EARLIER tests to
  that loopback too. `hits` then carries two traces' `acp.open` spans;
  the `byName` dedupe keeps the last, so `turn.parentSpanId` (fresh
  trace) `!== open.spanId` (stale trace) — the exact assertion observed
  failing on this host (`c4a752f1a7ae9965` vs `4a54a6c04d598605`).

The asymmetry that makes it bite: `acp-worker.test.ts` emits
incidentally BEFORE its trace test pins an endpoint. `otel-emit.test.ts`
pins its endpoint in `before()` for the whole file (no pre-pin queue),
`otel.test.ts` ships per-item explicit endpoints (no ambient lane), and
`acp-proxy.test.ts` already pins `BRO_TELEMETRY=0` at module scope — the
repo's own convention for exactly this channel.

## Design

Arm the kill switch, not the endpoint. Module scope in
`acp-worker.test.ts`:

```ts
// node --test runs each file in its own process — BRO_TELEMETRY=0 here
// keeps worker spans from queueing on the ambient provider.env/env
// endpoint and draining into the trace test's collector (same guard
// acp-proxy.test.ts carries)
process.env.BRO_TELEMETRY = '0';
```

- `enqueue()` returns at the `BRO_TELEMETRY === '0'` boundary before any
  endpoint resolves, so NOTHING queues from the incidental worker runs —
  immune to every resolution channel (env export, `provider.env`, a
  future one), where pinning a dead `OTEL_EXPORTER_OTLP_ENDPOINT` would
  still let queued items re-resolve into the repointed collector.
- The trace test already saves/deletes/restores `BRO_TELEMETRY` around
  its window, so its own spans keep emitting to the pinned loopback;
  restore returns `'0'`, keeping later tests muted.
- Side benefit: the suite stops POSTing spans to the operator's real
  collector — the stated reason `acp-proxy.test.ts` carries the pin.

Not in this spec: resolving `provider.env` under `XDG_CONFIG_HOME`
(specs/bro-uwoss.md names `~/.config/bro/provider.env` the contract;
the test fix needs no production change), and pinning other
emit-incidentally suites (they pollute but cannot flake — same
per-file pin applies when one grows an endpoint-pinning test).

## Verification

- Host: `~/.config/bro/provider.env` holds
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
- Before: `nx run-many -t test --skip-nx-cache` →
  `acp-worker.test.ts` "emits acp.open → acp.turn → acp.session as one
  trace" fails on `turn.parentSpanId !== open.spanId` (the only red of
  41 projects; nx cloud cache masks this — cached outputs come from
  hosts without the file).
- After: same command green; `tsx --test src/acp-worker.test.ts` green.
