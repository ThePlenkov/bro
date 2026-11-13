---
bead: bro-zaydc
---

# bro-zaydc — convoy run: systemic spawn failure must stop the queue, not drain it

## Problem

While `node_modules`/`dist` were wiped, `bro convoy run` against 22
molecules produced:

```text
run <mol-1> error — spawnSync timeout ETIMEDOUT      (attempts:0)
run <mol-2> error — spawnSync timeout ETIMEDOUT      (attempts:0)
… 20 more …
run: queue drained — 0/22 settled
```

Every spawn threw before a worker existed and the supervisor iterated
the entire queue in seconds. Two gaps in `convoyPolicy`
(`packages/rig/src/policies/convoy.ts`):

1. **The raw-throw catch conflates spawn-level and work-level
   failure.** In `molAttempt`, any throw that isn't a `SpawnError` —
   `spawnSync timeout ETIMEDOUT` (`bd()`'s execFileSync budget, the
   same signature as bro-cu3q8's store outage), an ENOENT on a dead
   binary, a wedged claim store, `SpawnInputError` — settles the mol
   `'error'` at `attempts:0` instantly. No retry, no classification —
   and `runQueue` moves on to the next mol.
2. **The queue has no memory.** `SpawnError` kinds
   `'unavailable' | 'config' | 'input'` — the taxonomy's own
   infra/non-work classes, the same grouping `loop.ts` already refuses
   to burn fix rounds on — fall to the bare-refusal path and burn
   attempts like a real work failure. Either way, N consecutive
   spawn-level failures (infra is DOWN) reads as N per-mol failures.

`bro-cu3q8` set the philosophy for the loop: infra failures hold the
tick — the pick retries next interval, never a supervisor death, never
a per-item verdict. The convoy is a bounded queue, not a resident
supervisor, so "hold forever" is wrong — but "park the queue" is the
same move in the convoy's vocabulary: consecutive spawn-level failures
with zero attempts must break the loop, not consume it.

## Design — the infra streak (circuit breaker)

`ConvoyCtx` gains a queue-scoped counter, `infraStreak` — consecutive
**work-boundary failures**: failures after which no worker existed and
no classified answer was given. A failure is counted at three sites:

- **Spawn throw, infra class** — `SpawnError` kinds
  `'unavailable' | 'config' | 'input'` (backend tooling down,
  misconfiguration, shared bad input — in the convoy shape every mol
  spawns into the same worktree/config, so these are systemic) **or any
  unclassified throw** (raw `spawnSync` errors, `SpawnInputError`).
  The mol does NOT settle: it waits one poll tick and retries — **no
  attempt burned** (`attempts` counts workers that ran; no worker ever
  existed). This is the cu3q8 hold, bounded by the streak.
- **Precheck read throw** (`loadMol`/`next` — a stalled store) and the
  **post-run re-read throw**: counted, but the mol settles `'error'`
  immediately — a permanent "mol not found" must not pay retries, and
  post-run a worker may be live (never blind-retry a spawn).
- **Streak reset**: any outcome proving the spawn machinery answered —
  a resolved `deps.spawn` (a worker exists, whatever happens to it
  next) or a *classified* `SpawnError` — `'cap'` waits and the
  `'conflict'` registry re-read (occupied/stopped/wall/bare refusal) —
  zeroes the counter. A successful precheck read alone does not reset:
  a healthy store says nothing about spawn health.

At `INFRA_FAIL_LIMIT = 3` the settling mol returns `'error'` flagged
`queueStop: true` and `runQueue` stops: the tripping result is pushed,
then every remaining mol is reported `'parked'` with
`queue stopped — <why>` (firing `onParked` per settle, like any parked
mol). Parked-not-run is the honest verdict — the mols were never
touched and wait for an operator rerun, same contract as a wall park.

### Why a shared streak instead of per-mol retries

The incident shape is a *dead spawn boundary*: retrying mol-1 longer
only delays the trip; failing mol-1 fast and iterating only drains the
queue faster. The streak makes the first mol cheap (`attempts:0`,
poll-tick retries) and bounds the whole outage to ~3 spawn throws,
after which the queue itself is the thing that parks.

### CLI surface (`commands/convoy-run.ts`, adapter-only)

`MolResult.queueStop` propagates to `--json` output; the summary line
prints `run: queue stopped — X/Y settled` when any result carries the
flag (the old `queue drained` wording claimed a completion that never
happened — the exact lie the incident printed).

### Non-goals

- The `'conflict'`/'cap' refusal paths are unchanged — a classified
  refusal is proof the machinery answered.
- `bro loop`'s resident-supervisor holds are unchanged — the convoy is
  bounded; it parks, it does not hold forever.
- No new verdict: `parked` already means "a wall with no advertised
  end"; the queue-stop flag rides the result, not the verdict space.

## Tests (`policies/convoy.test.ts`)

- K consecutive raw spawn throws → first mol `'error'`+`queueStop`,
  the rest `'parked'`, no further `spawn` calls, `attempts:0`.
- `'unavailable'` SpawnError streak behaves identically.
- Streak reset on a successful spawn: fail → success → work-fail →
  later fails count fresh.
- Mixed queue (work-level `failed`/`done` between spawn failures)
  still iterates — the breaker only trips on *consecutive* streaks.
- `'cap'`/`'conflict'` refusals never increment.
- Recovery: spawn fails twice then succeeds → mol completes, queue
  continues.
- Precheck read failures count toward the streak (stalled store
  trips the queue after K mols).
