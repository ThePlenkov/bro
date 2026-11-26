---
parent: bro-5tpx0
---

# bro-9wv18 — hooks: cut session-start/stop cost — cache probe results, parallelise probes

## Problem

Session-start and stop are latency-sensitive hook events. Independent
connector probes should not pay the sum of their latencies. The first
measurement used `scripts/bench-hooks.ts` with
`--runs 3 --warmup 0 --lanes runsh,dist`, but the generated CLI could not
load the unbuilt workspace package `@broject/rig/dist/index.js`. Every sample
therefore errored; the reported p50s (dist session-start 112 ms and dist stop
110 ms) are not valid before/after evidence.

Source inspection found that `packages/core/src/connectors.ts` already starts
active connector probes with `Promise.all`. `packages/cli/src/commands/hooks.ts`
also already overlaps the independent session-start and stop legs. A cache is
not safe to add without a correctness key and invalidation policy for mutable
beads, claims, gates, and worktree state.

## Design

Keep this first slice narrow: preserve and regression-test the existing
parallel collection contract rather than introducing a general cache.
`collectLines` starts every active connector probe before awaiting any result,
so wall-clock cost is bounded by the slowest probe (or the probe timeout).
Session-start rehydration and stop-gate callers continue to overlap their
independent connector, occupancy, guard, goal, and heartbeat reads while
preserving registry/output order.

Existing mode snapshots and the session-context cache remain unchanged; they
already have explicit scope and TTLs. No new lifecycle result cache is
introduced until a clean benchmark identifies a stable value and its
invalidation inputs.

## Acceptance criteria

- Connector session-start probes begin concurrently.
- Connector stop-gate probes begin concurrently.
- Probe output and fail-open/timeout semantics remain unchanged.
- No cache returns mutable lifecycle state after its correctness window.

## Verify

- `npx tsx --test packages/core/src/connectors.test.ts` passes, including two
  delayed connector probes for both session-start and stop-gate.
- `npx nx run @broject/core:typecheck --skip-nx-cache` passes.
- Re-run `scripts/bench-hooks.ts` after all workspace packages are built and
  record a clean before/after comparison in the PR. The attempted local run
  is not a performance gate because every sample failed dispatch.
