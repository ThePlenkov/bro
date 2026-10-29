---

parent: bro-l8c4f
scope:
- packages/core/src/agents.ts
- packages/core/src/janitor.ts
- packages/cli/src/agent-connectors.ts
- packages/cli/src/commands/proc-owner.ts
- packages/cli/src/commands/loop.ts
- AGENTS.md

---

# bro-l8c4f.5 — durable spawn handshake: close the crash window between spawn and handle publication

Parent: `bro-l8c4f` (principal audit — reliability). Audit item:
"Краш launcher между spawn и записью PID оставляет нерегистрируемого
живого worker" — the hypothesis came from operation order, not a
reproduced incident. This spec is the deterministic-failpoint
confirmation plus the minimal fix.

## Problem

The native spawn's critical section is:

1. `prepareSpawn` — guards, registry row (no pid), beads claim,
   `<agentId>.prompt.md` — all durable.
2. `spawn('sh', …, { detached: true })` — a live worker exists.
3. `patchAgentRegistry({ pid, pidStart })` + `writeWorkMarker` — the
   execution handle becomes durable.

A launcher killed inside (2)→(3) leaves a detached worker the registry
cannot name: the entry has no pid, `nativeState` falls to `lost`, the
step reads free, and a respawn runs a second worker beside the first.
The worker's `.exit` at `<agentId>.exit` is also shared across
attempts — a dead generation's late write can masquerade as the live
run's exit record.

tmux and docker already hold the property the native backend lacks:
their liveness handle (session name, container name) is deterministic
and published by the runtime itself, so `has-session`/`docker inspect`
find a survivor without the parent's patch. The fix gives the native
worker the same self-published handle instead of widening the parent's
synchronous section.

## Design

### Per-attempt runId

Every `commitSpawn` mints a `runId` (fresh on respawn — the agentId is
reused, the attempt is not) and records it on the registry entry.
Attempt artifacts are run-scoped:

- `<agentId>.<runId>.exit` — the attempt's exit record (was
  `<agentId>.exit`; an old attempt's late write lands in its own file,
  never the live run's)
- `<agentId>.<runId>.handle` — native only, the worker's self-published
  pid and its /proc starttime
- `<agentId>.<runId>.go` — native only, the launcher's admission stamp

`agentExitFileName(agentId, runId)` in core resolves the scoped name;
entries without `runId` (pre-change) keep the legacy path. The
`<agentId>.` prefix convention keeps janitor reaping working unchanged.

### The handshake (native backend)

Worker half, first statements of the wrapper `sh -c`:

1. `printf "%s%s" "$$" "${s:+ $s}" > $handle.tmp && mv $handle.tmp
   $handle` — publish the group-leader pid (`$$` == `child.pid`) and
   the wrapper's `/proc/$$/stat` starttime (`$s`, empty where /proc is
   absent) before anything else. The starttime is the identity readers
   verify against pid reuse: a handle whose pid now carries another
   starttime is a recycled pid and never adopts. A failed publish
   exits 74 — an unregisterable worker must not run.
2. Poll `$go` every 50 ms up to the spawn-handoff window
   (`SESSION_SLOT_TTL_MS`, the existing 2 min convention). Absent past
   the window = the launcher died mid-publish → write `.exit` 75 and
   exit — the payload never runs unowned.

Launcher half, unchanged section: `unref` → pid/pidStart patch →
`.work` marker → `writeFileSync($go)` — the admission stamp lands only
after the execution handle is durable.

### Recovery

`nativeState` ladder becomes: live pid → recorded death → **handle
adoption** → grace → `lost`.

- `adoptNativeHandle` — entry carries no pid but a live-pid handle
  file for its runId whose published starttime still matches the pid:
  stamp `pid`/`pidStart` into the entry under the same generation
  check the exit harvest uses, report `running`. A recycled pid (or a
  starttime the worker never published) never adopts.
  `status`/`down`/`fleetOccupancy`/`bro agents` all reach the survivor;
  dedup keeps refusing a second spawn beside it.
- A pid-less, handle-less, death-less entry inside the handoff window
  reports `spawned` — launch in flight or launcher dead pre-spawn;
  unverifiable is never free. Dedup and occupancy treat `spawned` like
  `running`; past the window it degrades to `lost` and respawns.
- `stop()` adopts before the kill decision, so `down` reaches a
  survivor whose pid never reached the registry.

### Failpoint seam (tests)

`armNativeSpawnTestSeam({ abandonAt?, goWaitTicks? })` — a test-only
hook that throws `SpawnAbandoned` at one of three points, leaving
exactly the state a dead parent leaves:

- `reservation` — after `prepareSpawn` (entry + claim, no OS child)
- `os-spawn` — after `spawn()` + `unref` (live child, no pid patch)
- `publication` — after the pid patch + `.work` marker (no `.go`)

`goWaitTicks` shrinks the worker's admission wait so the timeout path
is testable.

## Acceptance

Controlled failpoints prove each arm:

- `reservation`: entry exists, no child, state `spawned`→`lost`, respawn
  blocked while unverifiable then allowed.
- `os-spawn`: the worker's self-published handle is adopted (`running`,
  findable by `status`/`stop`); the payload never runs without `.go`;
  at wait timeout it exits 75 and the step is recoverable.
- `publication`: the entry's pid makes the survivor visible; `stop`
  kills it.
- Exit isolation: an old attempt's late `.exit` write lands in its own
  run-scoped file — the new run's record is untouched.
- At most one executing worker per step, or a refused spawn naming the
  recoverable state.

## Plan

- [x] core: `mintRunId`, `agentExitFileName`, `entryRunId`, `runId` on
  `AgentRegistryEntry`, `runId` on `AgentInfo`
- [x] `commitSpawn`: mint runId, run-scoped exit file, write runId into
  the entry; `prepareSpawn` returns it
- [x] native wrapper: handle publish + `.go` wait ahead of the payload;
  parent writes `.go` last; `SpawnAbandoned` seam
- [x] `nativeState` adoption + `spawned` grace; dedup `isLive` and
  `entryOccupies` count `spawned`; `stop()` adopts first
- [x] `.exit` readers go through the scoped name: `ensureExitCause`,
  exit-mtime stat, `proc-owner` `exitFileProves`, janitor `deadSince`,
  loop `workerExit` (WorkerRef carries `runId`)
- [x] tests: the five failpoint/isolation cases above
- [x] AGENTS.md: the `<agentId>.<runId>.*` artifact contract
