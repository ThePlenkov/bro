# bro-0ykhg.3 — brouter decision cache: an opt-in memo of route decisions

Child of bro-0ykhg (specs/bro-0ykhg.md). Depends on bro-0ykhg.2.

## Problem

The same kind of task (a dependabot bump, a codescene finding of one rule)
arrives many times; the judge answers it the same way every time. That is a
cost worth removing — but only when the operator wants it: a cached answer
is a stale answer by construction.

## Design

`brouter.router.cache = off | exact | recall` — **`off` is the default**;
the cache is a mode of the router, never required.

- **key** — canonical JSON (never string concat) of
  `{contextId, formulaHash, tableHash, shape, judgeConfigHash}` plus either
  the normalized full task text and carried T0 fields/features (`exact`)
  or the scoped T1 recall cluster (`recall`). `judgeConfigHash` covers the
  effective judge provider, model, parameters and escalation configuration,
  never credential material. Keys are available before T2; inferred
  answers belong only in the value, not the lookup key. Recall misses when
  no eligible cluster exists; .2's context and success rules still apply.
- **value** — the stage answers (not the route): the code re-runs filters,
  health and the chain on a hit, so a wall that appeared since is honored.
- **invalidate** — formula or table hash changes; TTL
  (`cacheTtlHours`, default 24); a verified outcome row (bro-0ykhg.4) that
  fails the formula's success predicate drops the source entry (including
  a multi-round merge under `merged_first_round`). The decision journal
  records the cache key/generation for both fresh writes and hits.
  Invalidation and cache writes are SQLite transactions with a persistent
  per-key generation. Capture the generation before T2; a write succeeds
  only if it is unchanged. Invalidation increments it even on a missing
  entry, preventing an in-flight miss from resurrecting a failed answer.
- **store** — a `decision_cache` table in router.db, written by the router.
- `--explain=route` says `cache: hit (age 3h, key …)`; `--no-cache` on
  `brouter route|ask` bypasses it.

## Verify

- off by default: no table rows written without the setting.
- A hit skips T2 (fake judge not called) but a wall added after the write
  still removes the walled lane.
- Formula edit → miss; failed outcome → entry dropped; TTL honored.
- Exact lookup before T2 needs no inferred answers; judge/model changes
  miss. Missing recall clusters miss without error.
- A multi-round merge invalidates under `merged_first_round`, not `merged`;
  a late concurrent write after invalidation is rejected transactionally.
