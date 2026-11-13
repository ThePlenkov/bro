---
bead: bro-u6fp5.1
slice: 2 of 3 — loop policy port (claim/gate/park/lost over Policy)
parent: bro-u6fp5
stacked-on: work/u6fp5 (PR #1044 — Policy interface + convoy port)
---

# bro-u6fp5.1 — the loop scheduler as a rig policy

Slice 2 of 3 for `bro-u6fp5` (spec `specs/bro-u6fp5.md`). Slice 1 landed
the `Policy` contract and the convoy port; this slice ports
`commands/loop.ts` — the claim → spawn → gate-stack → park/lost
scheduler, ~5.8k lines — onto the same shape: the FSM decision surface
moves to `packages/rig/src/policies/loop.ts` behind an injectable
`LoopDeps`, and the command file keeps argv parsing, lane resolution,
spawn mechanics, the audit, and output/process adaptation only.

Stacked on `work/u6fp5` (PR #1044): the `Policy` interface and the
convoy precedent live there until that PR merges; this branch is based
on it and the PR targets `main`.

## Problem

`loop.ts` is the heaviest command file in the tree and its scheduler is
a concrete `Ctx` bag of live-repo closures — `rev`, `tasks`, `agents`,
`stateCache`, `mirror`, config, plus ~40 module-level helpers that mix
store reads, git/fs IO, spawn mechanics, and the verdict logic. The
epic's contract (bro-oy3k1.1 §Policies) wants the scheduling *policy*
in the engine package with the command reduced to an adapter — the
same move slice 1 made for convoy, except loop's `Ctx` is not already
injected: the split itself is the work.

## Design

### The seam — `Ctx` → `LoopDeps` + `LoopCtx`

Every external touch the scheduler makes becomes one of three things:

- **Already-importable engine surface** — `@broject/core`
  (`TaskStore`, `ReviewFacade`, `AgentConnector`, `gitTry`,
  `withFileLock`, `emitLifecycle`, `watchBegin/End/Refresh` via
  `@broject/act`, `SpawnError`, `AgentNotFound`, session-slot fns,
  `procStat`, `pidAlive`, `readAgentRegistry`, `patchAgentRegistryIf`,
  `probeStep`, `bdActor`, `isAgentCause`, `wallText`, `bodyMeta`,
  `issueLink`, `stampPrOwnership`, `getTasks`, `projectId`, fs-private
  writers, `BATCH_MARKER_ENV`, …), `@broject/act`
  (`fetchPrActState`, `evaluateExitGate`, `gatePending`, `checkHistory`,
  `resolveLedger`, `ACT_STATE_TTL_MS`, `PrStateCache`), `@broject/loop`
  (NEW dep — `memberAction`, `planItem`, `clumpMembers`,
  `coveredBeadIds`, `orphanVerdict`, `beadForHead`, `ceilingHeld`,
  `diskFloorBreach`, `diskFloorBytes`, `buildWorkPrompt`,
  `buildFixPrompt`, `buildRebasePrompt`, `loopSlug`, `LoopConfig`,
  `LoopItem`, `GateSnapshot`, `FleetPrRow`, `ReconcileBead`, `MB`,
  `FLEET_HEAD_PREFIXES`, `isFleetHead`), and rig-internal
  (`rigNext`, `ReadyBead`, `processesRootedIn`, `Policy`). These ride
  on `LoopDeps` as plain objects/fields — `deps.tasks`, `deps.rev`,
  `deps.agents?`, `deps.stateCache`, `deps.mirror?`, `deps.leaseStore?`
  — or are imported directly.
- **`LoopDeps` methods** — the cli-module leaves and ambient IO the
  policy cannot own: output (`say`/`error`/`emit`), clock (`now`/
  `sleepMs`), run records (`beginRun`/`endRun`/`runLog`/`reapRuns`),
  the claim-side store reads that stay in `commands/next.ts`
  (`projectScope`, `claimCandidates`, `claimUpTo`), the spawn plane
  (`laneFor`, `spawnWorker`, `spawnTemplate`, `admitTemplate`,
  `providerWall`, `bootstrap`), the merge plane (`mergePr`,
  `settleSessions`, `reportOutcome`), the stack/worktree plane
  (`stackSlotFor`, `stackLockPath`, `recordStackEdge`, `syncStack`,
  `worktrees`), and `finishAudit`.
- **`LoopCtx` run state** — `q` (the `QueueState` the tick shares:
  seen/stack/tally/claimed/drained/parkedClaims/pushHoldUntil/
  diskHeld/wallHeld/infraErrors/holdStage/diskProbeWarned/
  unclosableNoted/ceilingRes), `stage`/`bead` (the heartbeat's liveness
  pair — the CLI's `guardedRun` keeps reading them off the same
  object), `tails`, `claimsHeld`, `scope` (opaque — only the deps
  consume it), `cfg` (`LoopConfig` + `intervalS`), `json`, `act`,
  `backend`, `repo`, `root`, `beadsDir?`, `stack?`.

### The Policy verbs

`loopPolicy extends Policy<LoopMember, LoopCtx, ServiceVerdict>` —
`LoopMember` is the old `GateMember` (beads/item/pr?/worker?/lane/
marker/since/nextPollAt/rounds/updatedSha/fetchErrors/serviceErrors/
wallWaitUntil/wallWaits/prompt), `ServiceVerdict` the old
`'kept' | 'active' | ItemResult`. The mapping the parent spec named:

- **select** — the push pick: `claimClump`'s candidate→lead→clump
  decision returns the claimed `ReadyBead[]` (or `undefined` on
  drain/max). The *admission* gates around it — `pushHoldUntil`,
  wall-waiters, the fleet ceiling + reservations, the disk floor —
  are `tryClaim`'s hold logic, kept verbatim inside the policy's own
  `tryClaim` driver (a policy never waits inside `select`; the holds
  are durable-state reads that answer "no pick this tick").
- **onGate** — `serviceGate`: the settled `GateSnapshot` →
  `memberAction` → the autoMerge remap → `land`/`merge`/`closed`/
  `fix`/`rebase`/`update`/`wait`/`park` settle. Gate rows, finalize,
  respawn rounds, and update-branch are the verdict path's own IO.
- **onPark** — `parkBeads` + `leave(m, 'parked')`: the defer/snooze
  write, the lifecycle `park` row, the watch release.
- **onLost** — the worker-`lost` settle inside `serviceWorker`: a
  terminal/superseded/missing registry read classifies through
  agent-verdict → wall-wait → park → `settleNoPr`, never a silent
  retry. `serviceWorker` keeps the poll half (status reads,
  fetch-error strikes, `.exit` records); the terminal classification
  routes through `onLost` with the poll's outcome carried on the
  member (`m.lost` — info/state/exit/superseded, set for the call).

`serviceMember` (cadence gate + wall-wait + marker finish),
`servicePass` (oldest-first dispatch + `failMemberService` strikes +
`retireMember`), `serviceWorker`, `pushItem` (claim → lane →
worktree → bootstrap → prompt → spawn → member/settle), `tryClaim`,
`claimClump`/`pickLead`/`claimMembers`/`claimableByLadder`/
`claimCustody`, `reconcileFleet` + its listing/verdict helpers, the
ceiling reservations, disk probes, and `run` (= `runQueue`'s tick loop)
are the policy's own drivers — the Policy verbs are the lifecycle
moments inside them, exactly like convoy's `run`/`runQueue` riding
alongside the four verbs.

### What stays in `commands/loop.ts`

argv parsing (`usage`/`num`/flag sets/`rejectStrayArgs`/
`everySecArg`/`runLoopSched`/`labelSelection`/`stackNameFlag`),
`runLoopCommand` + `guardedRun` (role lease, supervisor lock, signals,
heartbeat, death audit — process adapters), lane resolution
(`LoopLaneSel`, `resolveLoopLane`, `lanePicks`, `pickTier`,
`templateEscape`, `providerLaneOrEmpty`, `classLabelOf`,
`beadClassInfo`, `routeTableTask`, `routeTableLaneFor`,
`resolveBeadLane`, `resolveRunLane*`, `flagTierPin`, `effectiveAgent`,
`loopLaneSel`, `sayLaneNotes`), spawn mechanics (`agentEnv`,
`laneCommand`, `provenancePins`, `spawnAgent`, `spawnWorker`,
`specEnv`, `admitLaneSessions`, `admitCrossKindSessions`,
`laneSpawnedCommand`, `runBootstrap`), the end-of-run audit
(`endAudit` + `sweepLoopLitter`/`sayLoopAudit`/`syncAfterAudit`/
`claimedTails`/`learnMissTails`/`openLoopPrs`/`linkedWorktreeCount`/
`loopRefTails` consumers), dry-run (`dryRunPlan`/`dryRunDisk`/
`dryRunLane`), `buildCtx` → `buildLoopDeps`/`buildLoopCtx` assembly,
and the `LoopDeps` implementations themselves (thin closures over the
existing helpers). `LoopLane` moves to rig (it is member payload —
`SpawnWorker`/`SpawnSpec` are core types); `LoopLaneSel` stays.

`skipLeasedBeads`, `wallWaitUntil`, `loopWatch`, `loopRefTails` move to
rig with the FSM (they are policy internals); `loop.test.ts` updates
its imports to `@broject/rig`.

### Byte-identical contract

The move is verbatim modulo `ctx.X` → `ctx.deps.X`/`ctx.q.X` rewiring
and `console.*` → `deps.say`/`deps.error`/`deps.emit` (bound to the
same console calls, `say` still json-routed, `emit` still the
`--json`-gated `console.log(JSON.stringify(row))`). `guardedRun`,
`endAudit`, spawn mechanics, and every `say`/`console.error` string
are untouched, so `bro loop` output — progress lines, `--json` rows,
audit report, heartbeat — is identical by construction.
`loop.e2e.test.ts` is the regression net.

## Dependencies

`rig → {core, act, convoy, drill, loop}` — `loop → core` only, so the
graph stays acyclic. `packages/rig/package.json` gains
`@broject/loop`; `package-lock.json` is committed with it.

Boundary rules hold: no `plugins.ts`/`commands/*` imports, no
`process.exit`, no `console.*` in `packages/rig/src` — output rides
`deps.say`/`deps.error`/`deps.emit`.

## Verify

- `npm run build && npm run typecheck && npm test` at root (the CI
  command — all suites, quoted globs).
- `packages/rig/src/policies/loop.test.ts` — FSM unit coverage over a
  fake `LoopDeps` (no CLI imports): member service verdicts
  (kept/active/landed/parked/closed/failed), wall-wait and
  fetch-error strikes, the claim pick's hold/drain paths, spawn
  refusal/infra settles, lost-worker classification.
- `packages/cli/src/commands/loop.e2e.test.ts` + `loop.test.ts` stay
  green unmodified except moved-helper imports.
- Import audit: `grep -rn "commands/\|plugins.ts\|console\.\|process\.exit" packages/rig/src/policies/loop.ts` stays empty;
  `packages/rig` calls no `process.exit`.
