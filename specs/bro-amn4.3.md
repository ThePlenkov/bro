---
parent: bro-amn4
---

# bro-amn4.2/.3 — parallel probe sweeps + async read layer

## Problem

Baseline from bro-amn4.1's journal: session-start ~30s, stop ~23s,
pre-compact ~38s. Two compounding causes:

1. `collectLines` and `stopGateContributions` swept connectors
   **serially** — each probe carries a `PROBE_TIMEOUT_MS` budget, so
   worst-case latency was N × 4s.
2. Inside the probes, `bdTry`/`bdJson`/`gh`/`ghTry` are `spawnSync`/
   `execFileSync`. A synchronous child blocks the whole event loop:
   timeout timers can't fire, parallel sweeps don't actually parallel,
   and every sibling probe's measured time inflates. `Promise.all`
   alone changes nothing — the promise resolves only after the sync
   body returns.

Proof from the CPU profile: ~7.4s of one session-start spent inside
`spawnSync` across four chains — `listDrills` (drill), `currentPr` +
`resolveRepo` + `mergeSlotHolder` (act), `listLessons` (learn).

## Design

**Parallel sweeps.** Both collectors map connectors to probe promises
and `Promise.all` them; result order stays registry order. A probe
timeout/throw flips `settled` but never starves siblings. Worst case
is one probe budget, not N.

**Async read twins.** `bdAsync`/`bdTryAsync`/`bdJsonAsync` and
`ghAsync`/`ghJsonAsync`/`ghTryAsync` spawn with piped stdio and
resolve on `close` — same contracts as the sync forms (including
`bdAsync`'s `ETIMEDOUT` shape). Above them:

- `TaskStoreAsync`/`taskStoreAsync(dir)` — Promise-form read surface
  (`list/ready/get/children/deps/actor`); mutations stay sync.
- `tasksAsync(dir, prefer?)` — connector-resolving facade; a connector
  without `tasksAsync` wraps its sync store in `Promise.resolve`
  (compatible, not non-blocking).
- `ReviewFacade` optional async twins — `resolveRepoAsync`,
  `currentPrAsync`, `prMetaAsync`, `checksAsync`,
  `checkAnnotationsAsync`, `reviewedShasAsync`, `prFilesAsync`.
  `fetchPrActState` overlaps the independent reads and falls back to
  sync methods through resolved promises for hosts without twins.

**Converted probes.** beads, sdd, drill (`listDrillsAsync`,
`currentFrameAsync`), learn (`listLessonsAsync`, `probeCtxAsync`),
act (`gateLine`/`blockerLine`/`mergeSlotHolderAsync`,
`fetchPrActState`).

**Exit hygiene.** `trackChild`/`unrefPendingChildren` registry: async
spawns register at launch, deregister on close; the hooks entrypoint
unrefs stragglers after dispatch — a timed-out probe's bd/gh child no
longer holds the hook process open past the answer it already sent.
Command paths never unref, so awaited spawns pin the process as before.

## Invariants

- Sync surfaces stay: command paths keep `bd`/`gh`/`taskStore` — a
  single awaited call gains nothing from a Promise.
- Probe budgets unchanged (`PROBE_TIMEOUT_MS` = 4s); timeouts are real
  work exceeding the budget, not deadlocks.
- Fail-open preserved — a missing bd/host still yields zero lines, and
  no hook decision depends on the journal or the registry.

## Result (measured)

session-start 29.7s → ~4.4s wall (bounded by the 4s probe budget);
stop 22.9s → ~4.3s; post-tool ~1s. Timed-out probes report
`timedOut` in the perf journal and the process exits with the answer
it already emitted.
