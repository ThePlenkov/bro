# bro-l8c4f.3 — down says stopped only when the worker is dead

Parent audit: bro-l8c4f (stop-truthfulness), evidence at rev
674e3be — `stopAgent`/`cmdDown` in `agents.ts` and the native
connector's bounded kill-wait in `agent-connectors.ts`. Supersedes the
first take (PR #634) after its review: the verdict must come from the
connector that owns the unit, not from a facade re-probe of a possibly
stale facade snapshot.

## Problem

`stop()` is a request, not a result. The native connector SIGTERMs the
wrapper's process group, waits up to 2 s, and returns either way.
`stopAgent` reports `stopped: true` from the fact that `stop()` ran —
it never re-checks the worker — and `cmdDown`/`DELETE` announce
success unconditionally. Three ways a live worker gets reported dead:

1. **TERM-resistant leader** — the wrapper ignores the signal, the
   bounded wait expires, `stopped <id>` prints while the pid lives.
2. **wrapper dies, descendant survives** — the liveness guard checks
   the wrapper pid only. A TERM-resistant child keeps running; the
   `stopped` marker lands; the entry reads `lost`/`stopped` — both
   respawn-able — while a live writer still holds the worktree.
3. **verification failures are silent** — a probe that cannot answer
   (no /proc, unreachable backend, thrown stop) collapses into the
   same unconditional "stopped".

Acceptance: a TERM-resistant worker never yields a successful
`stopped`/HTTP success; a wrapper that dies before its descendant is
not respawn-safe; repeated `down` stays idempotent; a racing
replacement never receives the old run's signal; timeout/unverified
outcomes are visible to the operator.

## Design

### `stop()` returns `StopResult` — the connector owns the verdict

`AgentConnector.stop(id)` changes from `Promise<void>` to
`Promise<StopResult>`:

```ts
type StopVerdict = 'stopped' | 'timeout' | 'stopping' | 'unverified'
interface StopResult { verdict: StopVerdict; detail?: string }
```

- `stopped` — the execution unit is verifiably gone (and, for
  registry-backed backends, the `stopped` marker landed).
- `timeout` — the bounded wait expired with the unit still live.
- `stopping` — the request landed but this backend cannot confirm
  death itself (copilot's best-effort remote cancel, a gc session the
  supervisor reaps). Reported as accepted-not-confirmed.
- `unverified` — the connector cannot say either way (failed probe,
  thrown signal, unreadable process table).

Only the backend knows what "gone" means for its unit — a missing
tmux session is a corpse, a missing registry row is not (it may be
pruned), a remote cancel is unverifiable by construction. A facade
re-probe cannot express that and was what let a stale terminal
snapshot skip verification entirely.

### The native unit is the session, not the wrapper pid

The native spawn is a detached `sh -c`: session leader, process-group
leader, unref'd. Its **execution unit** is every process in its
session — a descendant that `setpgid`'d into a sub-group never
received `kill(-pgid)` — plus `setsid` escapees, which leave the
session but keep the inherited `BRO_AGENT_ID` env pin.

New helpers in `proc-owner.ts` (the cli layer's /proc leaf):

- `procUnitScan(leader, agentId)` → `UnitScan` — one /proc pass
  answering both legs: `members` = live procs with `sid === leader`
  from `/proc/<pid>/stat` (the post-`comm` split `procStat` uses;
  field 4 = pgrp, 5 = sid), each carrying `inGroup` for the
  `kill(-pgid)` cohort; `escapees` = live procs outside the session
  still carrying `BRO_AGENT_ID=<agentId>` in `/proc/<pid>/environ`
  (NUL-anchored exact match), excluding this process — a `bro` CLI
  run inside the worker inherits the pin and must not count/signal
  itself. `unverified` flags present-but-unreadable entries — a live
  proc we cannot attribute may BE ours, so it must not read as
  absent. Returns `'unknown'` when the scan itself cannot run.
- `procSessionId(pid)` / `procHasBadge(pid, agentId)` — the
  signal-time identity re-checks: a pid may recycle between the scan
  and the kill, so membership is re-read immediately before the
  signal.

`procUnitState(pid, start, agentId) → 'dead' | 'alive' | 'unknown'`:

- pinned `pidAlive(pid, start)` → `alive` (pid-reuse safe)
- `kill(-pid, 0)` proves the group exists → members decide:
  non-zombie members → `alive`; an unreadable scan on a /proc-bearing
  host → `unknown`; on a host without /proc the group probe is the
  whole answer → `alive` (documented platform limit: zombie-only
  groups read live until init reaps them, escapees are undetectable)
- group gone or zombie-only → the badge leg: a badged pid → `alive`;
  an unreadable scan → `unknown` on /proc hosts; otherwise `dead`

`unknown` never reads as `dead` — the same fail-open rule `pidAlive`
documents.

### Liveness surfaces consume the unit

- `nativeState`: `unit !== 'dead'` → `running` (an unverifiable unit
  is the occupied verdict — dedup refuses respawn; a false-occupied
  costs a skipped spawn, a false-dead races a live writer). A
  dead-leader/live-descendant entry therefore reads `running`, never
  `lost` — closing the respawn hole at its root.
- `registryEntryState` (proc-owner): same unit leg between the pid
  check and the recorded-death ladder, so the claim sweep does not
  release a claim whose unit still lives.
- `prepareSpawn`'s `isLive` rides `nativeState` — dedup gets the
  fix for free.

### `stop()` verifies before it records

Native `stop(id)`:

1. `findEntry` miss → `{verdict: 'stopped'}` (idempotent).
2. Unit probe; if not `dead`, the signal phase runs **inside the
   registry lock**: re-verify the generation (agentId + spawnedAt), then
   `kill(-pid, 'SIGTERM')` when the group is provably ours (pinned
   leader alive or in-group members present), per-pid `SIGTERM` to
   same-session members in other groups, and per-pid `SIGTERM` to
   badged escapees — each pid's identity re-read immediately before
   its signal so a recycled pid never eats a signal meant for a dead
   member. The lock makes check+signals atomic: a replacement cannot
   land mid-phase and catch them (dedup also cannot admit a spawn
   while the unit reads live — the respawn lands only over a dead unit,
   and then carries the same badge: generation check disambiguates).
3. Bounded wait (2 s, the existing budget) on the unit probe.
   Surviving members/escapees are named in `detail`.
4. Under the lock: generation changed → `{stopped}` with a
   `respawned during the stop` detail (the old unit is provably dead —
   the respawn could not have passed dedup otherwise); unit still
   `alive`/`unknown` → `timeout`/`unverified`, **no stamp**; dead →
   `stopped: true` patch + marker drop → `{stopped}`.

tmux/docker keep their shape — signal, bounded wait, re-probe under
the lock — but an unverifiable probe now returns `unverified` instead
of throwing, and a still-live session/container returns `timeout`.
gascity probes the session list after `session close`: gone →
`stopped`, still listed → `stopping`, unreachable → `unverified`.
copilot's `copilotCancelRemote` returns `stopped`/`stopping`/
`unverified` (cancel is a documented best-effort gap; the warn stays).
devin SIGTERMs the session pid and waits on `pidAlive`: dead →
`stopped`, alive → `timeout`, EPERM → `unverified`.

### The facade and both surfaces

`StopOutcome` gains `verdict` and `detail`; `stopped` becomes
`verdict === 'stopped'`. `stopAgent` catches a thrown `stop()` into
`unverified` (a failure the HTTP route must see as 409, not a 500),
and re-reads `conn.status` once after the stop so the reported `agent`
is post-stop truth, not the stale pre-stop snapshot. Connectors that
predate `StopResult` (a void resolve) keep the old contract — the
facade reads them as `stopped`.

- `cmdDown`: `timeout`/`unverified` → `die()` with the survivors/the
  backend's report and "not safe to respawn" (exit 1); `stopping` →
  a `stopping <id>` line with detail; `stopped` → the unchanged
  `stopped <id>` line. The verdict check runs before the terminal
  message — a stale `lost`/`exited` pre-stop read can no longer mask a
  live unit.
- `DELETE /api/v1/agents/<ref>`: `timeout`/`unverified` → **409**
  `{error, agent, stopped:false, verdict, detail?}`; `stopping` →
  **202** `{agent, stopped:false, verdict:'stopping', detail?}`;
  `stopped`/absent → the unchanged 200 body. Verdict handling is a
  helper so the route stays under the complexity ceiling.

### Non-goals

- No SIGKILL escalation. A bounded, visible refusal is this change's
  contract; escalation is a separate design decision.
- Non-/proc platforms (macOS) get group-existence liveness only —
  escapee detection is documented as unavailable there, never silently
  claimed.

## Verify

- `agents.test.ts` (`bro agents down`):
  - **TERM-resistant unit, signal proven delivered**: command
    `trap 'touch termseen.txt' TERM; while :; do sleep 60; done #
    {promptFile}` — the trap both survives and records receipt. `down`
    exits 1 naming the still-running unit, no `stopped` line, no
    `stopped` marker, `status` reads `running`, `termseen.txt` exists.
  - **dead wrapper, live descendant**: `(trap '' TERM; exec sleep 30) &
    wait $!` — `down` exits 1, no marker, `status` reads `running`
    (unit), and a second `up` is refused — the step is not
    respawn-safe.
  - **setsid escapee** (Linux): `setsid` a TERM-immune sleeper —
    badge liveness still holds the step occupied.
  - dead worker → `stopped <id>` exit 0 (existing idempotency test).
  - flaky-pid fake: a legacy void `stop()` keeps the old contract —
    exit 0, the `pid → unknown` respawn note still printed (the
    connector asserting done is its own verdict).
- `serve.test.ts`: `deps.stop` verdicts `timeout`/`unverified` → 409
  with `stopped:false` + verdict; `stopping` → 202; `stopped`/absent →
  the existing 200/404/503 rows unchanged.
- `agent-connectors.test.ts`: the contract's
  stop-is-idempotent/stopped-marker rows keep their shape on the new
  return type.
- Commands (from `packages/cli`):
  `XDG_CONFIG_HOME=/tmp/opencode/empty-config npx tsx --test
  src/commands/agents.test.ts src/commands/serve.test.ts
  src/agent-connectors.test.ts`, `npx tsc --noEmit`, then the repo's
  real CI command (`npm test` / `npm run typecheck`).
