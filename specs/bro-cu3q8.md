# bro-cu3q8 — loop must not die when the task store or bridge publish fails

## Problem

On 2026-10-25 ~18:47Z the running `bro loop --provider devin-acp`
supervisor exited code 1 while 2/2 fleet workers were alive and
mid-task. The store was mid-outage (the dolt remote moved; `bd sync`
was failing its pre-push integrity check), and the tail of the run log
was:

```
warning: bridge publish .beads/dolt-mirror-origin.git failed
  — remote: This repository moved. Please use the new location:
spawnSync timeout ETIMEDOUT
Exited with code 1
```

Reconstruction from the log shape: `runQueue`'s `finally` still ran the
audit (`reap error: bead list failed — spawnSync timeout ETIMEDOUT`)
and `bro sync` (warn-only — the `syncAfterAudit` boundary from
bro-qjbwq held), then a _pending_ exception resumed propagating through
the finally into `main`'s catch, which printed the bare
`spawnSync timeout ETIMEDOUT` and exited 1. The throwing call was a
`bd()`/`bdJson()` invocation inside the run's per-tick body — `bd()`
is `execFileSync` with a 15s budget (`core/bd.ts`), and the
`timeout`-supervised command literally surfaces as
`spawnSync timeout ETIMEDOUT` when the store wedges.

The queue's tick calls `bd()` unguarded in several places:

- `claimClump` → `clumpCandidates` → `readyBeads` → `store.ready()` →
  `x.json(['ready'])` — uncaught.
- `pickLead`/`claimMembers` → `claimUpTo` → `claimOne` → `store.claim`
  — deliberately rethrows non-race failures ("a bd outage must
  surface", `next.ts`).
- Member settle paths → `stampProjection` → `projectBeads` →
  `tasks.get`/`tasks.update`, plus connector calls and fs writes
  sprinkled through `serviceWorker`/`serviceGate`/`pushItem` — mostly
  caught per-site, but not all and not at one boundary.

AGENTS.md's gate rule: infra failures (quota, outage, runner flakes)
never block — a wedged dolt store, a moved remote, or a bridge-publish
timeout is exactly that class. It must degrade — warn + defer retry —
not kill the supervisor.

## Design

Two boundaries, one warning shape.

### 1. The tick boundary (loop.ts `runQueue`/`servicePass`/`tryClaim`)

- `servicePass` services each `GateMember` behind a per-member
  try/catch. A member's service throw counts a strike on
  `m.fetchErrors` (the same "consecutive failures" counter the fetch
  arms already strike and park on — a wedged store or dead spawn is a
  service failure, not a fetch failure, but the give-up contract is
  identical): under 3 strikes and inside `mergeTimeoutMin` the member
  is _kept_ with `nextPollAt` pushed out one interval — the pass
  continues with the next member, so one poison member can never
  starve the round-robin behind it. Past the strike/deadline budget
  the member parks exactly like the fetch arm does (`parkBeads` +
  `leave(m, 'parked')`).
- `tryClaim` wraps `claimClump` and `pushItem`. A `claimClump` throw
  is pre-claim — warn + `pushHoldUntil` (the same hold a full fleet
  arms) + `false`. A `pushItem` throw can land after claims exist —
  settle them exactly like `pushItem`'s own worktree/prompt arms
  (note + reopen + end the custody record), un-see the clump so the
  held retry can re-pick, then hold.
- The registry spawn's own claim can also hit the outage — the
  connector's `claimStep` runs `bd update --claim` under the spawn
  lock, and `spawnClass` already names the store-down shapes
  'unavailable' (`ran:false` timeouts, the `no beads database` exit
  line). `settleSpawnRefusal` used to fold that kind into the generic
  park arm — a wedge parked the bead, drained the queue, and ended
  the run exit-0. It now returns a settled `infra` outcome instead:
  no claim release (a killed bd may have half-written the claim, and
  a store that just refused can't be trusted with the release either
  — the dead custody record and the exit sweep own the residue), and
  `tryClaim` joins the same infra hold — un-see, hold an interval,
  re-pick.
- `runQueue`'s `for(;;)` keeps a last-resort catch around the whole
  tick: count consecutive tick errors on `QueueState`, name the stage
  `infra hold (N)` so the heartbeat and the `loop: process exiting`
  audit both classify the wait as infra (never plain code 1), warn
  once per strike with a retry hint, hold pushes for the interval, and
  keep the interval cadence. A clean pass resets the counter.

### 2. The sync/bridge warning shape (core/tasks.ts, cli sync.ts)

Bridge fetch/publish and store replication already warn instead of
failing the push leg. They now carry the retry hint explicitly —
`…; the next sync retries` — so a moved remote or publish timeout
reads as a deferred retry, not a verdict. `syncAfterAudit`'s own
warning gains the same hint (`; the next run's audit retries`).

### Out of scope

- `bd()`'s throwing contract stays — hooks and non-loop callers rely
  on it; the loop's boundary is the consumer-side fix.
- `loopScope()` failing at startup already degrades to a clean exit-0
  drain (audit still runs); re-attach of orphaned registry workers on
  the next start is the existing contract the incident verified.

## Acceptance

- `bd ready` (or any per-tick `bd()` call) failing/timing out mid-run
  → `loop: … — infra hold; the next interval retries` on stderr, the
  heartbeat reports `infra hold (N)`, the run keeps its cadence, beads
  stay unclaimed, and the process does not exit.
- A member whose settle path throws past the strike budget parks like
  the fetch arm — other members keep being serviced (no starvation).
- Bridge publish failure (moved remote / timeout) leaves the loop
  alive — the publish leg warns with a retry hint; the supervisor's
  interval continues.
- `bro sync --pull` keeps its strict nonzero-on-store-failure
  semantics.
