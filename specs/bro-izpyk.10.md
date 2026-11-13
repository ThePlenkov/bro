# bro-izpyk.10 — fleet claims: marker/occupancy read-migration

Governing spec: `specs/sessions/bro-izpyk.md` (branch
`devin/1792972271-fleet-spec`), "Claims and conflicts":

> **Migration.** Today's arming markers (`<git-common>/bro/hooks/*.armed`)
> and the occupancy entries in `agents.json` become claims. Bro-spawned
> agents (`BRO_AGENT_ID`) are sessions with a `spawnedBy` field.

F3 (`specs/bro-izpyk.3.md` §8, PR #1032) landed the WRITE side only:
`armSession`'s post-tool path dual-writes a `worktree:<cwd>` ledger claim
beside the `.work` marker, and its Deviations deferred "full marker→claim
read migration" to F4/F5. F4 excluded claims; .5 doesn't cover it — it fell
through. This bead is the read-side decision and its implementation: which
consumers of `.armed` markers and `agents.json` occupancy move to
`ClaimFacade.list`, and which stay — the spec's own escape hatch is that
markers may remain the fast gate-time cache while claims become the
cross-session truth.

## Audit — every reader, judged

Three durable artifacts exist today; the migration question is asked per
reader, not per artifact:

- **session markers** — `<git-common>/bro/hooks/<session>.<aspect>` files
  (aspects `work|task|act|drill|spec` + connector-owned), owner-pid tagged,
  repo-scoped by the common dir, sync `readdir`-cheap.
- **agents.json** — `<git-common>/bro/agents.json`, the spawned-agent
  registry: molStep, backend, spawnedAt, runId, worktree, log, plus the
  `.exit`/`.handle` liveness files under `bro/agents/`.
- **ledger claims** — `ClaimFacade.list(q)` rows: `resource`, `host`,
  `sid`, `project`, `leaseUntil`, `claimedAt`, `pid`, `pidStart`, `ttlMs`,
  `detail`. Machine-wide, liveness-swept, heartbeat-renewed; `task:*` is
  never enumerated (the bd claim stays the source of truth).

### Migration table

| Reader | Path | Verdict | Why |
| --- | --- | --- | --- |
| `readArmed` → `ctx.armed` stop-gate probes + `guard` | sync, per-hook hot path | **stays on markers** | The gate's question is *which aspects this session armed* — per-session intent (`work`/`task`/`act`/`drill`/…), not a resource lease. Claims have no aspect dimension: only `work` dual-writes at all; `task:*` deliberately delegates to bd; `act`/`drill`/`spec` have no lease. A claims read would answer a different question and could never gate `act`-armed stops. The `() => Set<string>` sync signature also feeds every connector's `stopGate` — an async sqlite read here infects the whole dispatch. Markers remain the gate-time cache the spec blesses. |
| `takeStopGateBlock`, `skillHinted`, `hinted/` markers | sync per-hook | **stays** | Gate one-shot/skill-dedup state — not arming records; nothing to migrate. |
| `janitor` `sweepSessions` | background sweep | **stays** | It *owns* marker lifecycle (TTL reap of `<session>.*`, `fired/`, cursors) — it must read markers to reap them. Claims carry their own dead-row sweep inside the facade. |
| `otherLiveWork` → `parallelLines` (session-start parallel-work nudge) | async, mode-active sessions only | **migrates — union** | The nudge is exactly "a live session holds work in this project" — the claims question. `claims.list({project})` catches sessions the marker scan can't (marker TTL'd while the session lives, ownerless staleness, a claim written from a sibling clone of the same project). The marker leg stays in the union: `agent-<id>.work` spawned workers and `BRO_HOOKS=0`-excluded children have no claim rows (no write side exists — see Non-goals). Own session excluded by `host+sid`; own agent tree under a rotated sid excluded by `pid`/`pidStart` (the bro-7022c rule markers already encode). |
| `liveWorkEntries`/`liveWorkDetails` (rig `proc-owner`) | sync primitive | **stays — as a union leg** | Remains the marker-side read the occupancy ladder and litter sweep consume; not replaced, joined. |
| occupancy ladder marker rung — `occupied`/`greenOccupancy` (`rig/occupancy.ts`) | sync verdicts over prefetched inputs | **migrates — union** | `OccupancyCtx` already consumes caller-gathered snapshots (`workDetails`, `watches`). It gains `claims?: ClaimRow[]` — rows a caller that *can* go async prefetched via `claims.list({project})`. A live `worktree:<path>`/`branch:`/`pr:` claim matching the candidate is the same "session owns this work" verdict a `.work` marker gives — machine-wide, heartbeat-renewed (`leaseUntil − ttlMs` reads as last proven activity, the `activeAtMs` the merge TTL needs). |
| `freshOccupancy` / `retireOrphanedWorktree` (in-lock refresh) | sync inside `acquireOccupancyLocks` | **migrates — via prefetch passthrough** | The lock-held section cannot go async (the registry lock is a file lock; an sqlite open inside it widens the contention window for no consistency win — hook-written claims never wait on the occupancy lock anyway). `freshOccupancy`/`retireOrphanedWorktree` gain an optional prefetched `claims` param; callers thread the pass snapshot. |
| `sessionOwner` (litter keep-plane for in-progress beads, `commands/work.ts`) | sync verdict over prefetched ctx | **migrates — union** | `LitterReapOpts.sessionClaims` — `bro work prune` (the sweep's only entry; drive's child spawns the same command) prefetches `claims.list({project})` once. A live claim naming the tree/bead is the same keep-reason a `.work`/`.task` marker gives. |
| `litterTreeVerdict` (litter keep-plane for closed-bead trees) | sync under the occupancy lock | **migrates — union** | The closed-bead keep ladder never consulted session markers — its `worktreeClaim` rung reads the in-tree `<gitdir>/bro/work` stamp. A live `worktree:`/`branch:` ledger claim is that stamp's machine-wide twin, so the claims rung sits right after it (same `sessionClaimOn` matcher `sessionOwner` uses; snapshot-fed, no extra IO inside the lock). |
| `markersExternalActivity` spawn guard (`session-planes/markers.ts`) | sync inside the spawn critical section | **stays** | `ExternalActivityPlane.externalActivity` is synchronous by contract inside the registry-lock spawn section — no async seam exists to read claims through. Worse, its verdict is *ownership classification*: live owner pid + `/proc/<pid>/environ` badges (`BRO_AGENT_ID`, `BRO_HOOKS=0`). Claim rows carry `pid`/`pidStart` but not the badge, so claims alone cannot decide "foreign vs bro-owned" — the plane's whole question. |
| `worktreeClaim`/`worktreeClaimInfo` (`<gitdir>/bro/work` in-tree stamp) | sync, under `claim.lock`+registry lock | **stays** | A different artifact than session markers: stamped by `claimWorktree` for drivers/operator `work enter`/spawn transitions — callers that often hold **no SessionKey** (a sessionless terminal can't hold a session lease). Its atomicity-under-occupancy-lock is the point; ledger claims write outside that lock and could never offer it. |
| `fleetOccupancy`/`fleetOccupancyFor`/`entryOccupies`, `registryAgents`, `liveSessionKeysByKind`, `lane.ts` budget/wall lanes, `litterOccupants`, `registryOwner` | sync | **stays on agents.json** | Spawned-agent *slot* accounting: backend liveness (tmux session names, docker containers, native `.handle` pids, `.exit` death files), `molStep`, `spawnedAt`, `runId`, `exitStatus`, `cause`/`resetAt`. None of it is a session lease — a claim row can't express "the tmux session named x is gone". The spec's "occupancy entries become claims" arrives with the spawned-agent→ledger-session write side (`spawned_by` rows exist; claims stamped at spawn are a later F-slice — see Non-goals). |
| Fleet occupancy *views* — `bro fleet` board `occupancy`, `bro agents status`/`planes/agents.ts`, webui `board.occupancy`, convoy/pipeline cap reads | — | **stays** | They render the `fleetOccupancy` numerator above. The claims view of record is `bro claim list` + `bro sessions` CLAIMS (landed in .3/.11). |
| tasks connector `parallelWork`/`stopGate` (claimed beads) | async | **stays** | `task:*` stays on the tasks facade by spec — already correct, not a marker read. |
| `bro status` worktree `claim` field | — | **stays** | Renders the in-tree `bro/work` stamp (stayed above); a claims column for the board is display surface, not a verdict — out of scope. |

## Design — the claims leg shape

All three migrations are **unions**: the claim leg is additive truth beside
the marker leg, never a replacement (spawned workers and marker-only
sessions would silently vanish from every verdict otherwise).

1. **`rig/occupancy.ts`** — `OccupancyCtx.claims?: ClaimRow[]`;
   `FreshOccupancy.claims: ClaimRow[]`; `freshOccupancy(dir, known,
   claims = [])` passes rows through so in-lock refreshes reuse the
   pre-lock snapshot; `retireOrphanedWorktree` gains a trailing optional
   `claims` param. New `claimProofs` rung inside the session-marker slot
   (after `worktreeProofs`, before `/proc`):
   - match: `worktree:<path>` wins on `resolve(path) === resolve(worktree)`
     or `detailMatches(detail ?? basename(path))`; `branch:<name>` on
     `detailMatches(detail ?? name)`; `pr:<n>` on `pr === opts.pr`.
     `task:*`/`role:*`/`path:*` are not work occupancy (enumerated anyway:
     `task:*` never returns, `role:*` is orchestration).
   - `activeAtMs = leaseUntil − ttlMs` (last heartbeat renewal) when both
     set, else `claimedAt` — honest for `greenOccupancy`'s TTL.
   - detail: `session <sid8> claims <resource>`.

2. **`rig/policies/drive.ts`** — `DriveDeps.claims?: () =>
   Promise<ClaimRow[]>` (the dep seam, tests inject stubs); `DrivePass.
   claims` gathered once per `pass`; `occCtx` and every in-lock
   `freshOccupancy`/`retireOrphanedWorktree` call thread
   `ctx.work.claims`.

3. **`cli/commands/drive.ts`** — `deps.claims` resolves `facade('claims',
   {dir}, {prefer})` once next to `store` and prefetches
   `list({project: sessionProject(mainRoot)})` per call; any failure →
   `[]` (degraded leg, pass unaffected).

4. **`cli/commands/work.ts`** — `LitterReapOpts.sessionClaims?: ClaimRow[]`
   → `ctx.claims.sessionClaims`; shared `sessionClaimOn` matcher feeds
   both keep-planes: `sessionOwner` (in-progress claim-release guard)
   and `litterTreeVerdict` beside the in-tree `worktreeClaim` rung
   (closed-bead keep). `cmdPrune` becomes async (`plugin.run` already
   `await`s) and prefetches best-effort.

5. **`cli/commands/hooks.ts`** — `parallelLines` gains a third leg:
   `claims.list({project})` filtered to live foreign holders — own
   `(host,sid)` excluded, own agent-tree `(pid,pidStart)` excluded,
   `role:*` excluded — rendered as `session <sid8> claims <resource>`,
   joined in the Promise.all with its own catch (`[]`, `settled`
   untouched). Reuses the `hookClaims` facade singleton.

## Coordinate note (bro-68a0y)

herdr's durable worktree↔agent-session ledger is adjacent state, not
overlapped: this bead adds no herdr plugin code and touches nothing under
`plugins/herdr/**`. The claims leg reads only the generic `ClaimFacade`
seam — the same contract herdr's session-bind surface consumes — so no
provider-specific logic lands in the shared path.

## Non-goals

- **Spawned-agent claim writes.** `agent-<id>.work` markers and agents.json
  occupancy cover workers bro spawned; stamping `worktree:` claims for
  them (a `spawnedBy` session's lease) is the write-side F-slice the epic
  reserves — without it a claims read adds nothing for that population.
- **`task:*` read migration** — the bd claim is the source of truth by
  design (specs/bro-izpyk.3.md §3); marker `.task` stays the session-aspect
  record.
- **Marker retirement.** Markers stay as gate-time cache indefinitely;
  nothing here deletes a write.
- **`bro status`/webui claims columns** — display surface, not a verdict.

## Files

- `specs/bro-izpyk.10.md` — this file.
- `packages/rig/src/occupancy.ts` — `claims` ctx/snapshot fields,
  `claimProofs` rung, `retireOrphanedWorktree` param.
- `packages/rig/src/policies/drive.ts` — `DriveDeps.claims`, pass gather,
  ctx threading.
- `packages/cli/src/commands/drive.ts` — `deps.claims` wiring.
- `packages/cli/src/commands/work.ts` — `LitterReapOpts.sessionClaims`,
  `sessionOwner` union, async `cmdPrune`.
- `packages/cli/src/commands/hooks.ts` — `parallelLines` claims leg.
- Tests: `rig/fleet.test.ts` (claim proofs + retire), `rig` drive-policy
  claims threading, `cli/commands/hooks.test.ts` (nudge leg),
  `cli/commands/work.e2e.test.ts` (claims keep rung through the real
  `work prune --loop` spawn).

## Verification

- `npm run build`, `npm run typecheck`, `npm test`.
- Live smoke: a `worktree:` claim for a foreign session shows in the
  session-start nudge and occupies the candidate in `occupied()` even with
  no marker on disk; a stopped claim frees both.
