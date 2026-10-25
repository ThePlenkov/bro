# bro-y3jvd — pace the lane: a shared rate gate, and the wall pauses every worker

## Problem

The devin account's free-model limit is a request RATE, not a daily quota
(epic bro-g0izo): a burst window (~1–2 min) and an hourly window
(~1 h). Every rejected attempt pushes the reset out.

bro already records the wall correctly — a `rate_limited` death lands on
the registry entry, `deriveProviderWalls` turns it into a provider wall
(spec bro-1x7p), and `batchWallRefusal` refuses NEW batch spawns while it
holds (spec bro-9h86l). What nothing does is *stop the spend that is
already in flight*:

- **The lane keeps hitting the wall.** A fixer spawned before the wall
  keeps sending turns after it — every attempt is another reset push.
  One worker dies reporting `rate_limited`; its four siblings keep
  feeding the same account.
- **The fleet discovers the limit by dying.** There is no pacing knob:
  `agents.devin.maxWorkers`/`maxSessions` cap CONCURRENCY, not request
  rate. Four parallel workers each burning requests inside the free
  window find the ceiling by crashing into it.

## Design

Three mechanisms, all fleet-scoped: the interactive lane is never
throttled or frozen — `bro agents up` is the operator's own work (the
bro-9h86l split stands: a wall the fleet hit is the fleet's problem).

### 1. The rate gate — a token bucket per lane model

`providers.<name>.rateGate` configures a token bucket for a spawn-surface
provider (cli/acp):

```jsonc
"providers": {
  "devin": {
    "type": "cli",
    "command": "devin -p --permission-mode dangerous --prompt-file {promptFile}",
    "rateGate": {
      "requestsPerHour": 240,  // refill rate — the account's known ceiling
      "spawnCost": 120,        // request budget charged per batch spawn
      "burst": 480,            // bucket capacity — default requestsPerHour
      "lane": "devin"          // shared bucket key — default: provider name
    }
  }
}
```

- **The unit is requests, not spawns.** A worker can't be metered
  mid-flight — bro never sees its turns — so each BATCH spawn pays its
  estimated lifetime request spend (`spawnCost`) up front, out of a
  bucket refilling at `requestsPerHour`. The fleet paces to the account
  ceiling instead of discovering it. `spawnCost` is an estimate the
  operator sets — too low under-paces, too high starves; the honest
  knobs are in config, not guessed in code.
- **Per model.** The bucket key is `<lane>/<model>` — a `typesafe/*`
  pin and a free-model worker draw different limits. An unmodeled
  spawn lands on `<lane>/(default)`. `lane` lets two provider entries
  that resolve to the same account (`devin` + `devin-acp`) share one
  bucket.
- **Host-shared ledger.** Bucket state lives at
  `$XDG_STATE_HOME/bro/lane-gate/` (one JSON file per key + a filelock —
  `withFileLock` semantics, tmp+rename publish). The account is shared
  across every repo's fleet on the host, so the budget is too.
- **Admission only.** The gate checks at spawn, inside `prepareSpawn`
  after the wall refusal and before the fleet cap — a refused spawn
  throws `SpawnError` kind `'cap'` naming the lane, model, and
  retryAfter. Interactive spawns never consult it. Corrupt/unreadable
  ledger ⇒ treat as a fresh full bucket (a hand-edited file must not
  wedge the lane; atomic writes make real corruption a config event,
  and the honest recovery is a fresh start, not a stall).

### 2. The wall pauses the lane

`reconcileLanePause(dir, env)` is the actuator that makes the derived
wall *stop the spend*, not just refuse new admissions:

- Desired set: every registry entry whose `provider` is currently
  walled AND is live (pid or process group). `providers.<name>.wallPause
  === false` opts a provider out; absent ⇒ pausing is on — a walled
  account is rejecting work, and a stopped worker cannot push its
  reset out.
- Freeze: `SIGSTOP` to the entry's process group (`kill(-pid)`) —
  the wrapper plus every child, mid-turn, socket held open. The
  worker simply stops making requests; when the group continues it
  resumes where it left off. No new machinery inside the worker.
- Thaw: when the wall lifts (reset passed, or the record stopped),
  `SIGCONT` the group.
- Records live in `<git-common>/bro/lane-pause.json` —
  `{pid: {provider, molStep, agentId, pidStart, pausedAt}}` — so a
  reconcile that sees the wall lift knows exactly which groups to
  thaw, and a reconcile that sees a stale pid (dead, or recycled —
  pidStart mismatch) drops the record WITHOUT signaling a stranger.
- Runs where the wall is (re)discovered: (a) in `prepareSpawn` — the
  batch-spawn refusal path freezes the lane the moment the fleet hits
  the wall again, even on a rig with no drive; (b) each drive pass —
  the periodic reconcile covers fleets spawned outside drive
  supervision and thaws lanes whose wall lifted.
- `bro fleet agents down` sends `SIGCONT` before `SIGTERM` — a signal
  pends forever against a stopped process, so an operator's kill must
  un-freeze the group first.

Interactive nuance: a *registry* worker on the walled provider pauses —
bro-owned labor stops spending a shared account that is rejecting. The
operator's own terminal sessions are not registry entries and are never
touched.

### 3. The lane's state in `bro agents status`

`bro agents status` gains a lane section: each provider that is walled,
pausing, or gated renders a line:

```text
lanes:
  devin: walled — rate_limited til 2026-10-28T15:36Z · 3 workers paused
  devin: gate default — 182/240 req budget
```

`--json` carries the same facts (`lanes: [{provider, wall, paused,
gate}]`). Fleet output already renders walls; this surfaces the lane the
fleet is actually holding.

## Non-goals

- Intercepting a worker's requests inside its process — bro has no
  per-turn seam into the devin CLI; SIGSTOP on the group IS the pause.
- Cross-host accounting, paid-tier accounting, per-request metering —
  the ledger is host-local and spawn-charged.
- Session caps — `maxSessions`/`maxWorkers`/`maxBatchWorkers` are
  concurrency controls; this bead adds the rate axis.

## Validation

- `lane-gate.test.ts` (core): refill math, per-model keys, burst cap,
  refusal retryAfter, lane aliasing, corrupt ledger recovery.
- `lane.test.ts` (cli): reconcile freezes live entries on walled
  providers and thaws on lift, skips dead/recycled pids and `wallPause:
  false`, `prepareSpawn` refuses under an empty bucket, freeze fires on
  the wall-refusal path, status renders the lane section.
