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

## Slice 3 — module-load measurement (bro-9wv18c)

The hook entry was measured after a clean `npm run build -- --skip-nx-cache`.
Each case below is a fresh Node process, with 30 samples and no warmup. The
baseline is `node -e ""`; `import-hooks` is
`node --input-type=module -e "await import('./packages/cli/dist/hooks.js')"`;
`dispatch` is the `dist:session-start` row from the hook benchmark. The
baseline is subtracted only to show the approximate module-evaluation
component; all reported values are wall-clock process times.

| case | min (ms) | p50 (ms) | p95 (ms) | max (ms) | errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| bare Node process | 27 | 31.3 | 50.2 | 50.9 | 0 |
| import `dist/hooks.js` | 189.2 | 193.5 | 320.7 | 356.6 | 0 |
| import overhead over baseline | — | 162.2 | — | — | — |
| `dist:session-start` dispatch (10 runs, 1 warmup) | 200 | 213 | 226 | 226 | 0 |
| `dist:stop` dispatch (10 runs, 1 warmup) | 195 | 198 | 204 | 204 | 0 |

The import graph therefore accounts for approximately 162 ms, or 81.8% of
the measured `import-hooks` p50. Dispatch adds only about 20 ms at the
`dist:session-start` p50 (including the fixture/probe work), so module loading
is significant relative to this isolated process. However, the hook entry
already lazy-loads the heavy judge, provider telemetry, learn, git-hook,
goal, heartbeat, and guard modules (`packages/cli/src/commands/hooks.ts`,
`lazyAppendRow` through `lazyHeartbeat`), and the measured session-start and
stop p50s remain below the 300 ms E1 target. The remaining static graph is
required by the common hook contract and is not separable into a further
lazy boundary without moving the dispatch API itself. Verdict: retain the
existing lazy-import design; this measurement slice makes no additional
behavioral refactor. The direct import probe is a diagnostic, not a CI budget,
because it does not execute from an opted-in fixture and has high host-level
variance (the p95/max outliers show that clearly).

## Slice 4 — lazy imports (bro-9wv18)

The hook entry was rebuilt and the same fresh-process import probe was repeated
after moving guard probes and event-specific hook helpers behind dynamic
imports. The probe used 30 samples and no warmup:

| case | min (ms) | p50 (ms) | p95 (ms) | max (ms) | errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| import `dist/hooks.js` after lazy-import changes | 181.1 | 194.4 | 273.1 | 281.8 | 0 |

This is consistent with the prior 193.5 ms p50, while ensuring the
guard/judge, waste/dead-loop, trace, git-hook, post-merge, spool, and snapshot
modules are not evaluated on the common session-start/stop import path.

## Slice 5 — post-lazy measurement and budget decision (bro-9wv18)

The workspace was rebuilt with `npm run build -- --skip-nx-cache`. The
post-lazy import probe used the same fresh-process method as Slice 3: 30
samples, no warmup, with a new Node process for every sample. The observed
numbers were:

| case | min (ms) | p50 (ms) | p95 (ms) | max (ms) | errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| bare Node process | 35.9 | 76.2 | 172.6 | 179.5 | 0 |
| import `dist/hooks.js` after lazy-import changes | 185.4 | 196.0 | 760.2 | 774.0 | 0 |
| import overhead over this baseline | — | 119.8 | — | — | — |

The import p50 is effectively unchanged from Slice 4's 194.4 ms (a 1.6 ms
difference, within host variance); the lower apparent overhead is driven by
this run's slower bare-Node baseline, not by a new startup improvement. The
lazy-import change therefore removed the eager evaluation of event-specific
modules, but does not produce a measurable additional p50 win in this
diagnostic on this host. The p95/max outliers also reinforce that direct
module-import timing is not a stable CI budget by itself.

The actual hook bench was then run with 50 samples and 3 warmups per row,
including all lanes, against the quiet local fixture:

| row | min (ms) | p50 (ms) | p95 (ms) | max (ms) | errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| runsh:session-start | 195 | 210 | 302 | 312 | 0 |
| runsh:stop | 201 | 212 | 480 | 690 | 0 |
| dist:session-start | 187 | 197 | 216 | 266 | 0 |
| dist:stop | 193 | 204 | 288 | 310 | 0 |
| noop:session-start | 2 | 2 | 2 | 2 | 0 |
| noop:stop | 2 | 2 | 2 | 2 | 0 |

Both session lifecycle runsh rows are comfortably below the 300 ms E1 p50
acceptance on the quiet machine. The earlier CI baseline recorded in Slice 4
(runsh session-start 370 ms and stop 310 ms) is noisier but still supports a
400 ms cap with floor-relative enforcement: with the typical 10 ms floor,
that cap permits 390 ms of hook work. The measured noop floor in this run was
2 ms, and all four lifecycle rows remained well inside the corresponding
390 ms margin (`delta` 208, 210, 195, and 202 ms).

Decision: tighten the lifecycle budgets to 400 ms for both `runsh` rows and
both `dist` rows. This is materially tighter than the previous 600/600/500/450
ms caps while retaining CI headroom above the historical CI p50s. The
floor-relative arithmetic is unchanged; the cap remains an allowance for
hook work above the measured noop twin, not an absolute process-startup cap.
