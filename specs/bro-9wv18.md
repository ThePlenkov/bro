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

## Measurement-driven continuation (bro-9wv18b)

The workspace was built with `npm run build`, then the benchmark was run with
the required command (20 samples and one warmup per row) before and after this
slice:

| row | before p50 (ms) | after p50 (ms) | errors |
| --- | ---: | ---: | ---: |
| runsh:session-start | 231 | 229 | 0 |
| runsh:stop | 305 | 226 | 0 |
| dist:session-start | 219 | 389 | 0 |
| dist:stop | 216 | 215 | 0 |
| runsh:post-tool | 328 | 312 | 0 |
| runsh:prompt-submit | 248 | 247 | 0 |

The benchmark creates a fresh session id for every sample
(`scripts/bench-hooks.ts` `rowInput`), so it does not claim repeated
same-session work. Its clean results also show that the approximately 300 ms
armed-path cost is process startup and dispatch work, not a probe result being
recomputed within one measured session. The one higher
`dist:session-start` sample is noise (the corresponding `runsh` lane did not
regress); it is still below the existing 500 ms budget.

Source inspection found that the only existing cross-event advisory cache is
the 30-second, per-directory/per-session `sessionContextText` cache in
`packages/cli/src/commands/hooks.ts`. It is network-free, atomic, and never
feeds stop-gate contributions; the stop gate remains live. The lifecycle
benchmark does not demonstrate another stable repeated read worth caching, and
the mutable beads/claims/gates/worktree inputs would require an explicit
invalidation key. Therefore this continuation adds no new cache or cache
complexity. The clean benchmark artifacts are `/tmp/bench-before.json` and
`/tmp/bench-after.json` from the implementation worktree.
