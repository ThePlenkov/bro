# bro-36sx7.1 — hooks: no waiting locks on the hook path

Bead: `bro-36sx7.1` (task) — parent epic `bro-36sx7`.

## Problem

Every `bro hooks <event>` is a fresh process on the host agent's critical
path — the host blocks until the hook answers. `acquireFileLock`'s
contention wait is `Atomics.wait` on the calling thread (filelock.ts
`syncSleep`), so any lock taken on the hook path is a synchronous stall
the session cannot interrupt. The hook path today takes real wait
budgets:

- `armSession` occupancy lock — `acquireFileLock` default 20s
  (hooks.ts:709-714) on every `.work` arm
- `journalTrace` / `appendJournal` / `flushPerf` — `withFileLock` 2s
  (hooks.ts:919, 993-1006, 1045) on every post-tool event and every
  event-end perf flush
- learn `inject` fired-set lock — `withFileLock` 2s
  (learn/connector.ts:357) inside session-start/prompt-submit/post-tool
- guard `runGuards` fired lock — `withFileLock` 2s (guard/engine.ts:409),
  the same count-check-append mechanism on every guard event
- `checkHistory.record` — `withFileLock` 2s (act/check-history.ts:75)
  inside `fetchPrActState`; a sync wait inside an async probe freezes
  the event loop and every sibling probe's timeout timer with it
- goal stop-eval lock — `withFileLock` 5s (goal.ts:335) on the stop event

A contended lock also isn't rare here: parallel tool calls fire parallel
post-tool hooks that all write the same session's journals and fired
sets.

## Design

Two rules for the hook path:

1. **Journals are lock-free O_APPEND rows.** `appendFileSync` is
   O_APPEND — each row lands atomically; concurrent writers cannot tear
   a line, so the append needs no lock at all. The only critical section
   the lock ever covered was the bound-trim (read → keep-last-N →
   rewrite). A trim is rewritten via tmp+rename instead: readers always
   see a whole file, and rows appended between the read and the rename
   are dropped — telemetry tolerates this (it is exactly what the old
   timeout fallback already did). Applies to `journalTrace`,
   `appendJournal`, `flushPerf`, `journalCommand`.
2. **Real invariants keep the lock but take it with `waitMs: 0`** — one
   acquisition attempt, no `Atomics.wait`, and contention runs the same
   fallback a timeout produced before:
   - `armSession` `.work` arm: the occupancy lock orders the marker
     against a driver's occupancy-check→spawn section; contended → the
     marker is written anyway (it is the session record — dropping it
     loses the arm entirely)
   - learn `inject` / guard `runGuards` fired sets: count-check-append
     is exactly-once under the lock; contended → the unlocked run(),
     the same double-fire degradation a timeout produced
   - `checkHistory.record`: hook callers pass `lockWaitMs: 0` (the
     `prStateCache(dir, { lockWaitMs: 0 })` pattern the act connector
     already uses); contended → the record is dropped, which the
     fail-open ledger already treats as an empty read
   - goal stop-eval: `waitMs: 0`; contended → the existing catch
     re-reads the fresh goal and degrades to the verify reminder

`acquireFileLock` already treats `waitMs: 0` as a single attempt —
non-hook callers (drive, work, daemon, spawn admission) keep their real
wait budgets unchanged.

## Plan

- [x] `core/filelock.ts` — document the hook-path contract on
  `FileLockOptions.waitMs`
- [x] `cli/hooks.ts` — `armSession` → `waitMs: 0`; `appendJournal` →
  lock-free O_APPEND + tmp+rename trim; `journalTrace` and
  `journalCommand` ride it
- [x] `learn/connector.ts` — `inject` fired lock → `waitMs: 0`
- [x] `guard/engine.ts` — fired lock → `waitMs: 0`
- [x] `act/check-history.ts` — `lockWaitMs` option; `act/connector.ts`
  passes `0` on the hook path
- [x] `cli/goal.ts` — stop-hook eval lock → `waitMs: 0`
- [x] `npm test` (tsx --test), `npm run typecheck`, `npm run build`
