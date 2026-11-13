---
bead: bro-u6fp5.2
slice: 3 of 3 — drive policy port (PR gate/fixer/merge over Policy)
parent: bro-u6fp5
stacked-on: none — loop policy merged to main (PR #1047)
---

# bro-u6fp5.2 — the drive supervisor as a rig policy

Slice 3 of 3 for `bro-u6fp5` (spec `specs/bro-u6fp5.md`). Slices 1–2
landed the `Policy` contract + convoy port (#1044) and the loop port
(#1047); this slice ports `commands/drive.ts` — the open-fleet-PR
watcher that gates every orphaned PR, spawns the fixer classes, and
merges the green — onto the same shape: the per-PR decision surface
moves to `packages/rig/src/policies/drive.ts` behind an injectable
`DriveDeps`, and the command file keeps argv parsing, config, output
routing, process/signal handling, and the deps wiring only.

This completes the parent's acceptance: all three runners
(loop/drive/convoy) are policies over `@broject/rig` — `bro-u6fp5`
(and its parent `bro-oy3k1`'s policy half) is satisfied pending merge.

## Problem

`drive.ts` is 2,815 lines with the same concrete-`Ctx` shape loop had
before its split: `rev`/`store`/`stateCache` facades, `env`
(`AgentConnectorEnv` — a CLI-module type rig cannot name), and ~20
module-level helpers that mix gate evaluation, occupancy-locked spawn
ceremony, merge/retire IO, and pass orchestration with the CLI-only
surfaces they call (judge annotations, foreign-push signals, the
herdr projector, the pipeline waker, the litter sweep, lane pause,
devin telemetry, `spawnStepAgent`, `settleAcpSessions`, `runActCommand`,
worktree/branch retirement in `work.ts`). The epic's contract wants
the scheduling *policy* in the engine package — the same move slice 2
made, smaller file, same recipe.

## Design

### The seam — `Ctx` → `DriveDeps` + `DriveCtx`

Every external touch the pass makes becomes one of three things:

- **Already-importable engine surface** — `@broject/core`
  (`ReviewFacade`, `TaskStore`, `TaskRow`, `AgentInfo`,
  `AgentRegistryEntry`, `PrMeta`, `CheckInfo`, `ReviewThread`,
  `gitTry`, `readAgentRegistry`, `emitLifecycle`, `SpawnError`,
  `stampPrOwnership`), `@broject/act` (`fetchPrActState`,
  `evaluateExitGate`, `checkHistory`, `resolveLedger`, `failingCiChecks`,
  `liveSastChecks`, `isSast`, `listWatches`, `watchHeartbeat`,
  `watchEnd`, `watchMarkerKind`, `PrActState`, `PrStateCache`,
  `ListedWatch`, `ExitGate`), `@broject/loop`
  (`LEARN_RETRO_CLOSEOUT`), and rig-internal (`rigNext`, the whole
  occupancy plane — `freshOccupancy`/`occupied`/`greenOccupancy`/
  `supervisedBy`/`supervisorFresh`/`acquireOccupancyLocks`/
  `retireOrphanedWorktree`/`agentProcessesIn`/`hooksDirOf`/
  `liveWorkEntries`, the fixer plane — `ensureFixerBead`/
  `fixerBeadFor`/`fixerPrFromRef`/`fixerAttemptSpent`/
  `recordFixerAttempt`/`FIXER_LABEL`, `ensureFixerWorktree`,
  `Policy`). These ride on
  `DriveDeps` as object fields (`deps.rev`, `deps.store`,
  `deps.stateCache`) or are imported directly.
- **`DriveDeps` methods** — the cli-module leaves and ambient IO the
  policy cannot own: output (`say`/`error`/`emitJson`), clock
  (`now`/`sleepMs`), the merge plane (`mergePr` — the `act merge`
  exitCode dance, `retireLanding` — worktree/branch retirement,
  `settleSessions` — `settleAcpSessions`), the spawn plane
  (`spawnAgent` — `spawnStepAgent`, `isAcpProvider`,
  `connectorAcceptsWorkers` — `resolveAgentConnector` + capabilities,
  `shadowNotes` — the judge annotation pass, `judgeBudget` — the
  per-run decide() bound), enumeration (`candidateBranches`,
  `worktrees`, `collectAgents`), pass ticks (`laneUsage`, `lanePause`,
  `litterSweep`, `projectorTick`, `armProjectorFeed`, `pipelineWake`),
  and the two signals (`publishAlert`, `signalForeignPush`).
- **`DriveCtx` run state** — `mainRoot`, `repo`, `host` (the reviews
  connector's name — fixer prompts name host-CLI syntax), `act`
  (`DriveActCfg` — the six normalized act knobs; standalone rather
  than `LoopActCfg`'s alias because `ignoreChecks` is the
  `IgnoreCheckRule[]` the config normalizer guarantees, not the
  wider `IgnoreCheckEntry[]` the fetch opts accept), `merge`, `json`,
  `connector?`, `occTtlMs`,
  `everySec?`, `litter` (the sweep throttle), and `work` — the
  per-pass `DrivePass` (worktree map, agent/occupancy snapshots,
  watch markers, judge budget, per-PR head SHAs, the open-PR set and
  select's pending queue). The command's `Ctx` extends this shape so
  the dep impls and process adapters read the same fields the policy
  writes — the loop port's exact contract.

`env` never reaches rig: every `AgentConnectorEnv` touch (ACP-provider
probe, connector worker capability, session settle, devin telemetry,
lane pause, the spawn itself) is a dep impl closing over the CLI ctx.

### The Policy verbs

`drivePolicy extends Policy<DriveWork, DriveCtx, PrVerdict | undefined>`
— `DriveWork` is `number | TaskRow` (a PR number for the gate verbs, a
fixer bead row for onLost — the same union-shaped item LoopWork
sets). `PrVerdict | undefined` is the verdict channel: gate verbs
answer a `PrVerdict`; park/lost settle through side effects (alert
delivery, bead close, say lines) and return `undefined`.

The mapping the parent spec named:

- **select** — the pass's service pick: `pending` is the open-PR set
  in enumeration order (`openFleetPrs`'s `prsForBranch` insertion
  order); select dequeues the next PR, `undefined` drains the pass.
  The enumeration itself — candidate branches → per-branch PR
  lookups → the `complete` flag — is `openFleetPrs`, the policy's
  own driver the pass calls before the select loop.
- **onGate** — `drivePr`: the per-PR gate evaluation. `fetchPrActState`
  → settled (`settleSessions` + `closeFixer`), `evaluateExitGate` →
  `gate.ok` → ownership stamp + `greenVerdict` (occupied/adopted →
  `mergeAndRetire`: `mergePr` → MERGED re-probe → `settleSessions` +
  `retireLanding` + `closeFixer`, OPEN → `enqueued`), else
  `blockedVerdict` — reopened threads park for the user, open threads
  → `spawnFixer`, CONFLICTING → `spawnRebaseFixer`, then the
  ci/sast `classSpawn` ladder bounded by `fixRounds > maxRounds`,
  each spawn behind the occupancy-locked `spawnFixerAgent` ceremony
  (fresh occupancy re-read → fixer bead → rig-next verdict refusal →
  ACP donor lookup → `spawnAgent`) with the same-head dedup
  (`fixerSpent`/`recordFixerAttempt`) and spawn-path re-probes
  (`freshOpen`, the rebase base-tip fetch + retarget re-check).
- **onPark** — the human-alert settle: `publishDriveAlert` keyed
  `drive-<cause>-<pr>`. The pass routes every `ALERT_VERDICTS`
  verdict (`blocked`, `spawn-refused`, `spawn-failed`,
  `merge-refused`, `merge-unverified`, `probe-failed`, `no-worktree`,
  `error`) and every `reviewer-alert` (the gate's advisory alerts)
  through it — drive's park IS "a human must look"; transients
  (`occupied`/`enqueued`/`spawned`/`settled`/`green`/`merged`/…) never
  alert, exactly as before.
- **onLost** — the settled-fixer sweep's per-row verdict: a fixer
  bead whose PR left the open set (`fixerPrFromRef` ∉ `work.prs`,
  bead not already closed) is probed once — `!OPEN` → `settleSessions`
  + `closeFixer` + the settled say line; still-open or probe failure
  → nothing. `sweepFixers` is the driver iterating
  `store.list({labels:[FIXER_LABEL]})`.

`pass` (the old `driveOnce`) and `run` (the old `runDrive` tail —
once-or-supervised `for(;;)` behind `armProjectorFeed` + `sleepMs`)
ride along as the policy's own drivers, the same contract convoy's
`run`/`runQueue` and loop's `runQueue` set. `emitWatchHeartbeats`
(loop-mode marker upkeep), `openFleetPrs`, `worktreeMap` (over
`deps.worktrees`), `metaOf`/`freshOpen`/`checksOf`/`annotationsOf`/
`gatedChecks`, `fixerLane`/`fixerSpent`/`fixerVerdictRefusal`,
`classSpawn`, `stampDriveOwnership`, `adoptedDetail`, `silentFor`,
`errText`, `closeFixer`, `fetchBaseTip`/`remoteList`, and the four
fixer work-order builders (`buildFixerPrompt`,
`buildRebaseFixerPrompt`, `buildCiFixerPrompt`, `buildSastFixerPrompt`)
move verbatim modulo `ctx.X` → `ctx.deps.X`/`ctx.work.X` rewiring and
`console.*`/`say(ctx,…)` → `deps.say`/`deps.error`/`deps.emitJson`.

### What stays in `commands/drive.ts`

argv parsing (`usage`/`DriveArgs`/`driveArgs`/`runDriveSched`/
`runDriveCommand`), the candidate-branch enumeration
(`FLEET_BRANCH_PREFIXES`/`candidateBranches`/`worktreeBranches`/
`fleetPrefixed`/`fleetBranches` — `watch.ts` imports them, and they
are the `candidateBranches` dep impl), the occupancy re-export shim,
`driveLockPath`, the pass-tick dep impls (`emitLaneUsage`,
`lanePauseTick`, `litterSweep`/`litterSweepTick`/`sayLitterSweep`,
`herdrProjectorTick` + the whole projector machinery — kicker,
watcher, bus events, write-point watches — `armProjectorEvents`,
`armProjectorWatches`, `kickProjector`), the signal dep impls
(`publishDriveAlert`, `signalForeignPush`, `driveShadowNotes`), the
spawn/merge dep impls (`mergeGreen`, `retireLanding`, `settleSessions`,
`isAcpProvider`, `connectorAcceptsWorkers`, `spawnAgent`→
`spawnStepAgent`), `driveDeps(ctx)` assembly, `Ctx` (the CLI superset
— every current field plus `deps`/`work`), `runDrive` ctx assembly →
`runDrivePolicy(ctx)`, and `runDriveCommand`'s role lease /
supervisor lock / signals / install-uninstall arms — all process
adapters, untouched.

`PrVerdict`, `BaseTip`, `fetchBaseTip`, and the four prompt builders
move to rig (they are policy surface — the work orders ARE the
spawn); `drive.test.ts`'s describes for them move to
`packages/rig/src/policies/drive.test.ts`, which also gains the FSM
coverage over a scripted `DriveDeps` (no CLI imports): select
drain/order, onGate's settled/green-occupied/merge-enqueued/blocked
verdict paths, the classSpawn decline ladder, onPark alert delivery,
onLost sweep settles. `candidateBranches`, `projectorKicker`,
`projectorWatcher`, `driveArgs`, `runDriveCommand`, and the
occupancy/rig re-export describes stay in `drive.test.ts` unmodified
except moved-helper imports — the re-export shim keeps them green.

### Byte-identical contract

The move is verbatim modulo the `ctx.X` rewiring above.
`driveOnce`→`pass`, `drivePr`→`onGate`, `sweepSettledFixers`→
`onLost`+`sweepFixers`, `runDrive` tail→`run` preserve call order,
await order, say/console routing (`deps.say` binds the same
json-route, `deps.error`→`console.error`, `deps.emitJson`→
`console.log(JSON.stringify(row))`), verdict strings, alert dedup
keys, watch-marker names, and exit codes. `drive-conflict.e2e`,
`drive-adopt.e2e`, `drive-sched.e2e` are the regression net.

## Dependencies

`rig → {core, act, convoy, drill, loop}` — **unchanged**: every
surface the FSM needs is already a rig dep or rig-internal; the
judge/devin/lane/foreign-push/herdr-projector/pipeline/
agent-connectors/work/act-command leaves inject as `DriveDeps`
methods instead of new package edges, so `package-lock.json` does not
move. Boundary rules hold: no `plugins.ts`/`commands/*` imports, no
`process.exit`, no `console.*` in `packages/rig/src` — output rides
`deps.say`/`deps.error`/`deps.emitJson`.

## Verify

- `npm run build && npm run typecheck && npm test` at root (the CI
  command — all suites, quoted globs).
- `packages/rig/src/policies/drive.test.ts` — prompt builders +
  `fetchBaseTip` (moved describes) plus FSM coverage over a scripted
  `DriveDeps`: select order/drain, onGate settled/green/blocked
  verdicts, `classSpawn` declines, onPark alert keys, onLost sweep
  settles, `pass` orchestration order.
- `packages/cli/src/commands/drive.test.ts` keeps the adapter
  describes (`driveArgs`, `candidateBranches`, projector helpers,
  `runDriveCommand` exit-listener, re-exported occupancy plane).
- `drive-conflict.e2e.test.ts` / `drive-adopt.e2e.test.ts` /
  `drive-sched.e2e.test.ts` green unmodified — byte-identical
  `bro drive` output.
- Import audit: `grep -rn "commands/\|plugins.ts\|console\.\|process\.exit" packages/rig/src/policies/drive.ts` stays empty;
  `packages/rig` calls no `process.exit`.
