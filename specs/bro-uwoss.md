---

parent: bro-uwoss
scope:
- packages/providers/src/otel.ts
- packages/providers/src/otel-emit.test.ts
- packages/core/src/http.ts
- packages/core/src/http.test.ts
- packages/core/src/index.ts
- packages/cli/src/commands/serve.ts
- packages/cli/src/commands/provider.ts
- packages/cli/src/commands/trace.ts
- specs/bro-uwoss.md

---

# bro-uwoss — dead loopback endpoints pin the emitter's event loop ~10s

## Problem

On this WSL2 box (`6.18.54-microsoft-standard-WSL2`) a `connect()` to a
closed loopback port never gets RST — the SYN sits in `SYN-SENT` until
the kernel gives up. That alone is survivable; the amplifier is in our
own transport:

- `fetch` (undici) rejects the _promise_ at `AbortSignal.timeout`, but
  its connect machinery stays ref'd until undici's internal
  `connectTimeout` (~10s). Measured on this host: an aborted fetch to a
  dead port settles at 1.5s while the _process_ cannot exit until
  ~10.5s. Every `bro` call emits `bro.cmd`/`hook.*` spans through
  `otel.ts`'s `post()` — a void'd fetch that still pins the loop — so
  every short-lived CLI (`bro hooks` on each tool call) lived ~10.5s
  and the agents' 10s hook deadline killed it (3395 "timed out after
  10s" across `.git/bro/agents/*.log`; `bro.cmd hooks` spans ~10.5s,
  status error).
- `postDetached()`'s `node -e` emit child carried **no timeout at all**
  — each dead-endpoint POST became a SYN-SENT victim burning CPU.
- Awaited loopback probes (`serve`/`provider` `defaultProbe`) fail at
  their 1s abort but pin the caller's exit ~10s the same way — the
  "client of a not-running local helper hangs to ITS timeout" class.

Operator mitigation already applied (a real collector on :4318), so the
symptom is quiet today; the transport defect is what this fixes. The
kernel RST defect itself is Windows/WSL-side — out of repo scope.

## Design

- **No in-process OTLP sockets, ever.** `otel.ts` `post()` and
  `postDetached()` stop fetching in-process. Emissions enqueue
  `{path, body}`; a flusher drains the queue into ONE detached
  `node -e` child that POSTs the batch (`<ep><path>` per item,
  OTLP/HTTP-JSON unchanged). A dead endpoint can only cost the child —
  never the caller's loop.
  - **Flush triggers:** an unref'd ~2s timer on enqueue (near-real-time
    for long-lived emitters — serve, acp workers), a one-time
    `process.on('exit')` drain (short-lived hooks deliver the whole
    batch in one child), and `postDetached()` flushing immediately —
    its contract is "the caller is gone", so it drains whatever is
    pending plus itself. Ordering inside 'exit' follows listener
    registration: `index.ts`'s `bro.cmd` handler was armed before any
    span existed, so `endDetached` enqueues + flushes last and carries
    every unflushed probe span.
  - **Bounded child:** each POST gets `AbortSignal.timeout(3s)`
    (unchanged per-request bound) and a hard `setTimeout(exit, 8s)`
    wall — even if undici pins the child's loop past the abort, the
    child self-terminates. No more unbounded emit children → no
    SYN-SENT accumulation.
  - **Argv transport, chunked:** the batch rides argv like today
    (`ep` + JSON items); chunks pack ≤96KiB per child (Linux
    `MAX_ARG_STRLEN` is 128KiB) so a busy burst can't E2BIG the spawn.
  - Same drop contract: no endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` env
    or `~/.config/bro/provider.env`) or `BRO_TELEMETRY=0` → nothing
    enqueues. Endpoint resolution now re-reads the env var per call
    (cheap) and caches only the provider.env file read — a test or a
    respawned worker can repoint the endpoint mid-life.
- **`getJson(url, timeoutMs)` in `@broject/core`** — a `node:http`
  GET whose destroy-at-deadline frees the pending connect _at_ the
  deadline, not ~9s later (verified: `req.destroy()` kills the ref'd
  `TCPConnectWrap` `socket.unref()` cannot reach). `serve` and
  `provider` `defaultProbe` swap to it: dead loopback helper ⇒
  undefined at 1s _and_ the process exits at ~1s, not ~10.5s.
- **`bro trace export` force-exits** — `runTraceCommand` calls
  `process.exit(code)` unconditionally so a settled/aborted POST
  doesn't leave the detached flush child hanging on undici's pinned
  handles (keep-alive on success, dead-connect cleanup on failure).
  The child now lives ≈ the POST's own settle time.

## Plan

- [x] spec (this file)
- [x] `otel.ts`: queue + `emit()` + bounded emit child; env endpoint
  re-read per call
- [x] `core/src/http.ts` `getJson` + index export; swap both
  `defaultProbe`s
- [x] `trace.ts` `runTraceCommand` → `process.exit(code)` always
- [x] tests: `otel-emit.test.ts` (live sink delivery, batching,
  postDetached, `BRO_TELEMETRY=0`, dead endpoint no-throw,
  queued-exit regression: emitting process exits <5s against a
  dead port), `http.test.ts` (`getJson` live + dead + timeout)

## Non-goals / out of scope

- The WSL2 kernel RST defect (no `ECONNREFUSED` on closed loopback) —
  Windows-side; the bead's `<5ms` acceptance is a machine property the
  repo can't produce. Code-side contract instead: a dead endpoint
  costs the caller nothing beyond its own deadline.
- `bd`/dolt client stalls — Go internals of another binary.
- `sinks.ts` webhook/telegram fetch — same undici class but external
  endpoints and a different config domain; nothing here configures one.
- `serve-provider` upstream proxy and the conductor — a server process
  whose pinning delays a response, not a process exit; request-path
  behavior unchanged.
- Dropping the `OTEL_EXPORTER_OTLP_ENDPOINT` pin in worker spawn envs —
  it's the spec'd trace-nesting contract (bro-xeozo); the operator's
  collector is live.
