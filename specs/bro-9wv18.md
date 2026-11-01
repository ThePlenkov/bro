---

## parent: bro-5tpx0

# bro-9wv18 — hooks: cut session-start/stop cost — cache probe results, parallelise probes

## Problem

Session-start and stop hook invocations are slow enough that the latency
budget needs tightening. The 2026-10-16 architecture review identified
probe serialization and repeated reads as cost drivers. Bro-qbnre
established the baseline and CI budget; bro-arm83 handles the no-op
fast-path; this bead cuts live session-start/stop cost via caching and
parallelism.

## Design

### 1) Profile (telemetry spans)

Use existing `otelSpan`/perf journal to identify the top probes on
session-start and stop. Spans already wrap probes in hooks.ts
(`probeReporter` opens `hook.probe.*` spans). No new heavy profiler
required — rely on the existing telemetry.

### 2) Parallelise probes

- `rehydrateLines`: run `goalContextLines` and `heartbeatLine` in
  parallel with the probe sweep (or with each other). They are
  independent of `sessionStartProbe`/`parallelWorkProbe`.
- `parallelLines`: run local marker scan (`liveSessionLines`) in parallel
  with `parallelWorkProbe` (connector probes). They are independent.
- `emitStopGateBody`: already parallelises `goalP`, `stopGateContributions`,
  and `guardLines`. Ensure `goalContextLines`/heartbeat reads are not
  blocking unnecessarily and that any remaining serialization is removed.
- Keep registry order for outputs where it matters; parallelise reads,
  not semantic ordering of emitted blocks.

### 3) Cache probe results

- Cache network-free/session-stable reads per (dir, sessionId) with a
  short TTL (align with existing `CONTEXT_CACHE_TTL_MS = 30_000` where
  appropriate).
- `sessionContextTextCached` already exists (30s). Extend caching to
  `goalContextLines` reads and `heartbeatLine` where cheap/safe (or
  memoize within the hook invocation).
- In connector probes, leverage existing timeouts and avoid repeated
  work; prefer cached values when safe.
- Cache must be best-effort and fail-open (never block on cache I/O).

### 4) Lazy-import heavy modules in hook entry

In `packages/cli/src/commands/hooks.ts`, move heavy imports used only in
specific paths to dynamic `import()` inside the functions that need them
(or gate behind usage). Examples: `otelSpan` is used throughout but can
be imported lazily where it adds overhead; `runGuards`/guard code paths
are heavy — lazy load when guards actually run; judge modules lazy load
on demand. Keep startup cost down for no-op/fast paths.

## Acceptance criteria

- E1 bench: session-start and stop p50 ≤ 300 ms (budget tightened in CI)
- No behavior change to hook semantics (blocks, hints, arming remain
  correct)
- Fail-open on all caching/lazy-loading paths

## Verify

- `node scripts/bench-hooks.ts` shows session-start and stop p50 ≤ 300 ms
- `npm test` passes
- Hook behavior unchanged in integration tests
