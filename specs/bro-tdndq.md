# bro-tdndq — free-tier lane pacing: pause the lane at a work budget, never at the wall

## Problem

A free-tier devin worker sustains ~4 req/min and exhausts the account's
rolling hourly window in ~50–80 min of runtime (bead bro-tdndq, epic
bro-g0izo). The fleet's pacing so far is all *reactive*:

- the rate gate (spec bro-y3jvd) paces ADMISSION — but its `spawnCost`
  is a fixed per-spawn estimate, blind to how long a worker actually
  runs. A lane of long-running workers spends past it;
- the wall + pause (spec bro-y3jvd) stops the lane only AFTER a worker
  died `rate_limited` — and dying at the wall escalates the reset
  (observed: 5m → 1h35m → 3h). Every wall death is a real worker lost.

What's missing is a pre-wall gate that meters the thing the account
actually limits: **worker running time inside the rolling window** —
the honest proxy for requests bro can observe (requests ≈ 4/min per
running worker on the free model).

## Design

### Config surface

`agents.<kind>.workBudgetMinutes` — worker-minutes per window the batch
lane may spend before the lane parks. `agents.devin.workBudgetMinutes:
50` keeps the account under the provider window with headroom
(~45–50 is the suggested operating point for the free tier).

`agents.<kind>.workBudgetWindowMinutes` — the rolling window, default
60. Both knobs live in the `agents.<kind>` bag like the other lane
quotas (`maxSessions`/`maxWorkers`/`maxBatchWorkers`) — verbatim bag, no
schema addition; a present-but-malformed value refuses 'config' at
admission, never silently unguards.

The lane unit is the **session kind**, not the provider entry: one
account behind `devin` + `devin-acp` spawns the same kind of devin
session — `agents.devin` budgets them together with no `lane` alias.

### The ledger — running-time segments, host-shared

`$XDG_STATE_HOME/bro/lane-budget/<kind>.json` records worker segments:

```jsonc
{ "workers": {
    "<scope>:<agentId>": {
      "scope": "<projectId>",        // which repo's registry owns it
      "paused": true,                // frozen mid-run — resume reopens
      "segments": [{ "s": 1731250000000, "e": 1731250300000 }]
    } } }
```

- A **segment** is one running interval `[s, e)`. Admission opens one;
  a lane freeze (wall or budget) or a worker's end closes it. Only
  RUNNING time accrues — a SIGSTOP'd worker is not spending, so its
  segment must close at freeze or the spend would never decay.
- **Spend** = Σ over segments of overlap with `[now−window, now]`,
  summed across every repo's workers on the kind — the account is
  shared, so the budget is too (lane-gate convention). An open
  segment's contribution caps at one window (`min(now, s+window)`) —
  a worker whose end was never recorded bleeds at most one window
  of spend and then prunes itself out (the zombie bound).
- Records carry `scope` (projectId of the owning repo): a reconcile
  or admission prunes **its own** dead workers — entries the local
  registry shows stopped/exited — and never touches another repo's
  still-live segments.

### Admission integration point

Inside `checkSessionLanes` (`admitSessionSlot`, the kind's host-wide
admission mutex) — after the concurrency caps, before the slot claim:

- batch spawns only (`isBatchSpawn(workerEnv)`) — the budget is the
  fleet's; the interactive lane is never throttled;
- `spend >= budget` ⇒ `SpawnError 'cap'` naming
  `agents.<kind>.workBudgetMinutes` + `retryAfterSec` — the projection
  of when spend decays below budget (the caller waits a poll tick,
  like every other 'cap');
- admitted ⇒ the worker's first segment opens atomically inside the
  same mutex (key = `<scope>:<agentId>`, scope = the caller's
  projectId). A spawn that dies before commit leaves a phantom open
  segment — the next admission/reconcile prunes it (key not live), the
  zombie cap bounds what a missed prune can cost.

This covers loop workers AND drive fixers — both run `prepareSpawn` →
`admitSessionSlot` (same admission path as the session quotas).

### Pausing live workers — the budget rides the wall-pause actuator

`reconcileLanePause` gains the budget as a second freeze trigger:

- Desired-paused set adds: live `native` registry workers whose
  `sessionKind`'s budget is spent (a segment-close accompanies the
  SIGSTOP — frozen workers stop accruing). Pause records carry
  `budgetKind` when the entry's kind has an armed budget, whatever the
  freeze reason — thaw knows what to reopen.
- Thaw: a record survives while its provider wall holds OR its
  `budgetKind`'s spend is still ≥ budget. On SIGCONT,
  `laneBudgetResume` opens a fresh segment — running time accrues
  again. Spend < budget ⇒ thaw ⇒ spend grows ⇒ refreeze: the lane
  duty-cycles under the ceiling instead of dying over it.
- `providers.<name>.wallPause: false` opts out of budget pauses too —
  one actuator, one opt-out.

The reconcile's `liveKeys` prune (registry entries with
`sessionKind` live and unexited) closes segments of workers that ended
anyhow — exit, `bro agents down`, reap — making explicit end-records
unnecessary; the zombie cap is the last-resort bound.

`bro agents status` lane section renders the level:
`devin: work budget 38/50 min (60m window)` — and when spent, the park
line with the thaw ETA.

## Non-goals

- Per-turn metering (`usage_update` telemetry turn caps) — bro has no
  per-request seam into a cli worker; running time is the observable
  proxy and the knob the bead names.
- Interactive-lane spend accounting — the interactive lane is never
  throttled OR metered (rate-gate convention).
- Cross-host accounting; non-`native` backend freezes (same SIGSTOP
  reach limit as the wall pause).

## Validation

- `lane-budget.test.ts` (core): segment overlap math, admit refuses at
  budget with retryAfter, window decay re-admits, open-segment zombie
  cap, pause/resume closes + reopens accrual, scope-scoped reconcile
  prunes only the caller's dead, corrupt ledger recovers empty.
- `session-planes.test.ts` (core): `workBudgetMinutes` arms the quota,
  a spent budget refuses batch admits 'cap', interactive admits
  unaffected, malformed value refuses 'config'.
- `lane.test.ts` (cli): budget-spent reconcile freezes live native
  workers of the kind (segment closes), decayed spend thaws (segment
  reopens), `wallPause: false` opts out, status renders the budget
  line.
