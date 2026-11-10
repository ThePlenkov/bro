---

## parent: bro-36sx7

<!-- markdownlint-disable-file MD041 -->

# bro-36sx7.2 — core: async git twins; probe paths off spawnSync

## Problem

Hook events run every connector probe in one Node process, in parallel,
under a per-probe timeout (`probeWithTimeout`, PROBE_TIMEOUT_MS). A
`spawnSync`/`execFileSync` inside any probe freezes the whole event
loop: sibling probes' timeout timers can't fire, the hook's own budget
can't trip, and the host agent watches a hung hook until it kills at
10s. #701 landed `gitTryAsync`/`gitUpstreamBehindAsync` and the async
`sessionContextText`/`probeCtxAsync`/`listLessonsCachedAsync` shells —
but several probes still reach a sync git read _inside_ the async
shell, which freezes the sweep the same way:

- `learn/connector.ts` — `hooksDir` (`rev-parse --git-common-dir`),
  `sessionContextText`'s `sessionTaskClaims` (marker-dir `rev-parse`),
  and `listLessonsCachedAsync`'s stamp read (`beadsStoreStamp` →
  `beadsDir` → `gitTry`).
- `drill/connector.ts` — the same `hooksDir` + `beadsStoreStamp` pair
  inside `frameLine`/`currentFrameCachedAsync`.
- `guard` — `liveState.branch()` and `readDiffPaths`
  (`status --porcelain=v1 -z -uall`); `runGuards` resolving
  `hooksDir`.
- `act/pending-watch.ts` — `watchesDir` (`execFileSync rev-parse
  --git-common-dir`) under `listWatches`/`hasLiveWatch`, reached from
  the act connector's `sessionStart`/`stopGate`.
- `sessionTaskClaims` (core) — a sync `rev-parse` wrapped in
  `Promise.resolve` inside the beads `stopGate`/`parallelWork`
  probes and `sessionContextText`.

## Design

Twin, don't replace — the codebase's established pattern
(`bd`/`bdAsync`, `ghTry`/`ghTryAsync`, `probeCtx`/`probeCtxAsync`):
sync signatures stay for command paths and interfaces; hook-probe
paths get Promise-returning twins built on `spawnCollect`.
`gitTryAsync`/`gitUpstreamBehindAsync` already exist (#701); this
change adds the remaining twins and moves the probe call sites.

- `gitCommonDirAsync(dir, timeoutMs?)` — async twin of the memoized
  `gitCommonDir` (bro-36sx7.8): same `gitCommonDirCache` (a warm sync
  probe serves the async read), same shared deadline across the
  `--path-format` probe and the plain fallback, same canonicalization.
  The deadline/cache scaffolding is extracted once
  (`commonDirCall`, `cacheResolvedCommon`) so the twins can't drift.
- `beadsDirAsync(dir)` / `beadsStoreStampAsync(dir)` — the cache-stamp
  read inside `listLessonsCachedAsync` / `currentFrameCachedAsync` is a
  disguised `gitTry`; the async cache helpers take the async stamp.
- `sessionTaskClaimsAsync(ctx)` — marker/fs reads stay sync; only the
  common-dir probe goes async.
- `learn`: `hooksDir`/`hooksDirAsync` delegate to
  `gitCommonDir`/`gitCommonDirAsync` (the canonical probe — ends
  another inline `rev-parse` copy); `probeCtxAsync`,
  `sessionContextText` (claims read), and `listLessonsCachedAsync`
  move to the twins. The dead sync `probeCtx`/`listLessonsCached`
  drop with it. `drill`: the local `hooksDir` drops to
  `gitCommonDirAsync`; `currentFrameCachedAsync` takes
  `beadsStoreStampAsync`.
- `guard`: `LiveState.diffPaths()`/`branch()` become Promise-returning,
  memoized promises (one spawn still serves every clause, and the
  memoization contract — identical instance per call — survives).
  `runGuards` resolves `hooksDirAsync`. `armed`/`exists` stay sync —
  pure fs.
- `act`: `watchesDir` consolidates on
  `gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS)` — same bound as the
  inline execFileSync, plus the canonical `--path-format` probe +
  canonicalization. `listWatchesAsync`, `hasLiveWatchAsync`,
  `deadWatchPlanAsync` twin the read path for the connector
  (`watchLines`, `watchCover`, `rearmWatches`); the write markers
  (`watchBegin`/`watchHeartbeat`/`watchVerdict`) stay sync — they run
  on command paths, never inside a hook sweep.

Out of scope (still `spawnSync` on a hook path, but changing them is an
interface rework, not a twin): `pickConnector`'s `remoteUrl` probe —
`facade()` is a sync API consumed by every command and probe;
`specStore`'s `siblingHasSpec` scan — `SpecStore.hasSpec` is sync by
contract. Both are memoizable once bro-36sx7.8's pattern extends.

## Plan

- [x] `gitCommonDirAsync` in `@broject/core` git.ts + export (shared
  cache + deadline scaffold with the sync twin)
- [x] `beadsDirAsync`, `beadsStoreStampAsync` in bd.ts + exports;
  `sessionTaskClaimsAsync` in connectors.ts + export, both
  beads-connector probes migrated
- [x] learn: `hooksDirAsync`, `probeCtxAsync`, `sessionContextText`
  claims read, `listLessonsCachedAsync`; drill connector off
  `gitTry`
- [x] guard: async `LiveState` git reads; `runGuards` on
  `hooksDirAsync`; `ownClaimsMissingSpec` (cli/spec.ts) on
  `sessionTaskClaimsAsync`
- [x] act: `watchesDir` on `gitCommonDir` + async read twins;
  connector `watchLines`/`watchCover`/`rearmWatches` migrated
- [x] tests: `gitCommonDirAsync` coverage next to the cache tests;
  `probes.test.ts` awaits the LiveState reads

## Verify

- `npm run build`, `npm run typecheck`, `npm test` (tsx --test, the CI
  command).
- The #701 `gitTryAsync` tests already cover the verdict shape,
  timeout kill, and upstream drift; the new coverage asserts the
  common-dir twin answers like its sync form and shares its cache.
