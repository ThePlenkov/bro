# bro-cye — debt collect: unbounded serial scan stalls on repos with many merged PRs

## Problem

`bro debt collect` with no filters defaults to `--last 50` merged PRs and
then scans each target **serially**: every PR costs 5-7 `gh` round-trips
(`pr view` meta, GraphQL `reviewThreads`, `pr view` labels, `pr edit`
×1-3, `pr view` updatedAt), each ~1-2s of `spawnSync`. On a repo with
~50-100 unprocessed merged PRs the run takes ~10min, emits only a per-PR
line with no progress/ETA, and reads as hung — users kill it mid-scan,
leaving a half-labeled queue. `debt watch` shares the same scan loop, so
the stall recurs every interval.

## Design

The root cause is per-PR serial round-trips, not the window size. Fix the
call shape, keep the semantics:

- **`ghAsync`/`ghJsonAsync`** in `@broject/core` — spawn-based async
  variants of the `gh` helpers so connector code can actually overlap
  host calls (the existing `Promise` facade signature on `reviewThreads`
  is async in name only while `gh()` blocks the loop).
- **`scanMergedPrs(targets, {concurrency, onProgress})`** — new OPTIONAL
  `ReviewFacade` fast-path: one bulk probe carrying meta + threads +
  labels + `updatedAt` per PR. GitHub implements it as chunked aliased
  GraphQL (`p0: pullRequest(number: N) {…}`, ~15 PRs per `gh api graphql`
  call, chunks at bounded concurrency). A PR with >100 threads falls back
  to the paginated `reviewThreads`. Missing map keys are probe failures —
  the caller falls back to the serial per-PR path, so partial scans still
  harvest.
- **`labelPrs(ops)`** — optional bulk label write: `gh pr edit
  --add-label/--remove-label` per PR under the same concurrency cap, then
  one chunked `updatedAt` re-query so callers get post-write cursors
  without a serial `pr view` per PR. Missing keys = failed writes (the PR
  stays unlabeled → rescan next run, self-healing).
- **CLI collect flow** becomes probe → commit: the bulk probe fills a
  scan map; the per-PR loop writes harvest rows + decides labels from
  probe-fresh labels (the probe replaces the old pre-write `labels()`
  re-fetch — same freshness, bounded by chunk latency); label writes +
  `markProcessedAt` cursors run after the loop, batched when the facade
  offers `labelPrs`. `debt:skipped` still wins — never written over, still
  earns a cursor. `--dry-run`, `--list-only`, `--thread-author` keep
  current behavior.
- **Progress** — the scan phase prints `probed i/N (~Xs left)` per chunk;
  the commit phase numbers its existing per-PR line `[i/N]`. The scan no
  longer looks hung even when the host is slow.

Fallback contract: connectors without the optional methods (and any PR
the bulk probe misses) run the exact serial path as today — correctness
never depends on the fast path.

## Plan

- [x] `core/gh.ts`: `ghAsync`, `ghJsonAsync` (spawn + Promise, same error shape)
- [x] `core/review.ts`: `MergedPrScan`, `ScanOpts`, optional `scanMergedPrs` + `labelPrs` on `ReviewFacade`; export from index
- [x] `debt/collect.ts`: extract pure `collectThreads` (meta+threads → records) out of `collectPr`; export
- [x] `github/reviews.ts`: `pooled` concurrency helper, `scanMergedPrs` (chunked alias query + per-PR threads fallback), `labelPrs` (parallel `pr edit` + chunked `updatedAt`), `reviewThreads` on `ghAsync`
- [x] `cli/debt.ts`: restructure `collectReviewThreads` — bulk probe, per-PR commit with `[i/N]` progress, batched label writes + cursors, serial fallback per PR
- [x] Tests: extend fake-gh harness for `scanMergedPrs`/`labelPrs`; `collectThreads` unit test
- [x] `npm test` + typecheck, PR
