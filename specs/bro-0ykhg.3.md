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
  `{formulaHash, tableHash, shape}` plus either the normalized task
  features (`exact`: the T0 fields + the formula's answers when a previous
  T2 produced them) or the T1 recall cluster (`recall`).
- **value** — the stage answers (not the route): the code re-runs filters,
  health and the chain on a hit, so a wall that appeared since is honored.
- **invalidate** — formula or table hash changes; TTL
  (`cacheTtlHours`, default 24); an outcome row (bro-0ykhg.4) with
  `result != merged` for a decision served from this entry drops it.
- **store** — a `decision_cache` table in router.db, written by the router.
- `--explain=route` says `cache: hit (age 3h, key …)`; `--no-cache` on
  `brouter route|ask` bypasses it.

## Verify

- off by default: no table rows written without the setting.
- A hit skips T2 (fake judge not called) but a wall added after the write
  still removes the walled lane.
- Formula edit → miss; failed outcome → entry dropped; TTL honored.
