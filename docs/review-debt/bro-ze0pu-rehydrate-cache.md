# Rehydrate goal and heartbeat read measurement

The `rehydrateLines` path in `packages/cli/src/commands/hooks.ts` invokes
`goalContextLines` and `heartbeatLine` once each, as independent legs of the
same `Promise.all`. There is no repeated goal or heartbeat read within one
hook invocation, so a short-lived cache would not avoid duplicate work. The
heartbeat is also intentionally mutable on every watch tick.

## Measurements

The checked-out revision was measured with the existing hook benchmark:

```text
node scripts/bench-hooks.ts --runs 20 --warmup 2 --lanes dist --json
```

All 20 samples in every lane completed without errors. The relevant
end-to-end rows were:

| Hook event | min | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| `dist:session-start` | 213 ms | 240 ms | 284 ms | 293 ms |
| `dist:prompt-submit` | 217 ms | 260 ms | 299 ms | 299 ms |

Because the benchmark includes process startup and the complete probe sweep, a
direct synchronous-file baseline was also run against a temporary git
repository with valid goal and heartbeat files. Across 10,000 consecutive
calls, the per-call means were:

| Function | Calls | Total | Mean |
| --- | ---: | ---: | ---: |
| `goalContextLines` | 10,000 | 96,001.337 ms | 9.600134 ms |
| `heartbeatLine` | 10,000 | 155.600 ms | 0.015560 ms |

The goal measurement includes its repository-boundary lookup and is not a
duplicate-read measurement: it is still called only once by each rehydration.
The heartbeat read is sub-millisecond, and caching it would risk serving a
stale tick. Since neither read is repeated within a hook invocation, the
measurement does not justify adding a cache. This closes the review question
without a behavior change.
