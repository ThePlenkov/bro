---
bead: bro-u6fp5
slice: 1 of 3 — Policy interface + first policy port (convoy)
parent: bro-oy3k1
---

# bro-u6fp5 — loop/drive/convoy as policies over @broject/rig

Parent epic `bro-oy3k1` (one lifecycle state machine per work item;
loop/drive/convoy are *policies* over the engine, not daemons of their
own — spec bro-oy3k1.1 §Policies). `bro-jamp7` landed the engine in
`packages/rig` (`rigNext` verdict, fleet ownership plane); this bead
turns the three runners into policies over it. The bead spans **three
PRs by design** — this slice is the `Policy` interface plus ONE port.

## Which policy this slice ports — and why convoy

The design order lists loop first, but the slicing rule allows the
cleanest seam. Reading the three runners:

- **`commands/loop.ts` — 5,843 lines.** The claim→spawn→gate-stack→
  park/lost FSM is real but its context (`Ctx`) is a concrete bag of
  live-repo closures, not injectable deps; the IO/decision split is
  itself a multi-PR extraction. Not the clean seam.
- **`commands/drive.ts` — 2,815 lines.** Same shape — `Ctx` concrete,
  per-PR pass entangled with spawn/git/forge IO.
- **`commands/convoy-run.ts` — 663 lines, already the policy shape.**
  `RunDeps` is a fully injectable IO surface ("tests drive the whole
  classification matrix without a repo, a backend, or real sleeps"),
  `runMol`/`runQueue` are the per-item FSM, and `convoy-run.test.ts`
  already proves the matrix. The port is a **move**, not a rewrite —
  byte-identical output by construction.

This slice ports **convoy**. Loop and drive get follow-up beads (below)
— each needs its `Ctx` split into deps+policy before it can port the
way convoy just did.

## Problem

After `bro-jamp7` the lifecycle *engine* lives in `@broject/rig`, but
the runners' scheduling policy still sits in `packages/cli/src/
commands` — `loop.ts` alone is ~54% of the command surface's weight.
The epic's contract: policies are `{predicate → action}` sets over item
state evaluated over the engine; command files keep argv parsing +
output only. There is no named contract for "a policy" — each runner
invented its own loop.

## Design

### `Policy` — the lifecycle contract (`rig/src/policy.ts`)

```ts
interface Policy<I = unknown, C = unknown, V = unknown> {
  /** Pick the next item to advance; undefined drains the queue.
   *  Durable-state reads only — a policy never waits inside select. */
  select(ctx: C): I | undefined | Promise<I | undefined>;
  /** The item reached or sits at a gate: the gate verdict. */
  onGate(ctx: C, item: I): V | Promise<V>;
  /** The item must park: the settle verdict (note/wake/release is the
   *  policy's own IO inside its verdict path). */
  onPark(ctx: C, item: I, why: string): V | Promise<V>;
  /** The item's worker or claim is lost: re-queue, park, or terminal —
   *  auditable, never a silent retry. */
  onLost(ctx: C, item: I): V | Promise<V>;
}
```

The four verbs are the transition kinds every work item can take
(`queued → claimed → working → pr_open → gate_blocked → merged →
closed`, with `park`/`lost` reachable from any active state —
spec bro-oy3k1.1 §Item states). `I`/`C`/`V` are the policy's own item /
context / verdict: loop's `GateMember`-ish record / `LoopCtx` /
`ServiceVerdict`, drive's PR row / `DriveCtx` / `PrVerdict`, convoy's
mol id / `{deps, cfg}` / `RunStep`. The interface names the lifecycle
moments; each policy's verdict vocabulary is its own — convoy's
`done`/`failed`/`stopped`/`occupied`/`blocked`/`error` ride the same
`V` channel and are not all named transitions.

### `convoyPolicy` (`rig/src/policies/convoy.ts`)

Moves the whole `runMol`/`runQueue` FSM — it was already policy-shaped:

- `RunDeps` — the injectable IO surface (loadMol/next/listOpen/spawn/
  status/entry/entryState/fleetFull/sleepSec/now/say + settle hooks).
- `RunArgs` — the knobs (mols/open/attempts/pollSec/retryDelaySec/json).
- `MolVerdict`/`MolResult`/`RunStep` — the verdict taxonomy.
- The classification helpers — `precheck`, `molAttempt`, `pollAgent`,
  `afterRun`, `refusalOutcome`, `blockedDecision`, `dagVerdict`, the
  fast-fail backoff — verbatim; they *are* the FSM's decision points.

The FSM's decision points route through the `Policy` verbs:

- **select** — the queue pick: `cfg.mols` order, `--open`'s
  `listOpen()` merged without duplicates (was `runQueue`'s id list).
- **onGate** — a mol whose `next.state === 'gate'` settles `gated`
  (both the precheck and the post-run re-read moments).
- **onPark** — a provider wall with no advertised end (quota,
  rate_limited without reset) settles `parked`.
- **onLost** — the worker's terminal/refused classification: `blocked`
  entry → wall wait or park, `stopped` → operator verdict, live entry
  → `occupied`, attempts exhausted → `failed`, else `retry`/`wait`
  `RunStep`s.

`done`/`blocked`/`error` are mol-state terminal verdicts the driver
returns directly — success/cycle/unreadable are not the four named
transitions. `convoyPolicy` also carries `run`/`runQueue` — the
per-item FSM driver and the queue driver — as policy-specific methods
beyond the `Policy` interface (the interface names lifecycle moments;
the driver is the policy's own engine).

`commands/convoy-run.ts` keeps the adapter half: `runArgs`/`numFlag`/
`RUN_KNOWN_FLAGS` (argv), `runnerPrompt`/`runnerSpawnReq` (the work
order + spawn request), `publishGate`/`publishParked`/`publishStopped`/
`publishFailed` (events IO — also `convoy wait`'s gate alert),
`entryOps` (registry wiring), `runConvoyRun` (deps assembly, verdict
render, exit code). It imports the FSM from `@broject/rig` — no
re-export shim: this slice *is* the shim removal for convoy.

### Dependencies

`rig → {core, drill, act, convoy}` — still acyclic (`convoy → core`
only). `Molecule`/`ConvoyNext` are type-only imports;
`AgentNotFound`/`SpawnError`/`agentEntryBlocked`/`AgentInfo`/
`AgentRegistryEntry`/`AgentState` come from `@broject/core` (already a
dep). Boundary rule holds: no `plugins.ts`/`commands/*` imports, no
`process.exit`, no `console.*` — output rides the injected `deps.say`.

## Deferred — follow-up beads

- **loop policy** — `claimClump`/`tryClaim` (select),
  `serviceMember`/`serviceGate`/`memberAction` (onGate),
  `parkBeads`/`leave(m,'parked')` (onPark), the worker-`lost` settle
  in `serviceWorker` (onLost). Needs the `Ctx`→deps+policy split first.
- **drive policy** — `openFleetPrs`/`drivePr` pick (select),
  `greenVerdict`/`blockedVerdict` (onGate), blocked/alert verdicts +
  `publishDriveAlert` (onPark), `sweepSettledFixers` (onLost). Same
  `Ctx` split.

## Verify

- `npm run build && npm run typecheck && npm test` at root.
- `packages/rig/src/policies/convoy.test.ts` — the FSM matrix moved
  from `cli`'s `convoy-run.test.ts` (the `world()` harness + every
  `runMol`/`runQueue` describe), now running over `@broject/rig` with
  no CLI imports and no `process.exit`.
- `cli`'s `convoy-run.test.ts` keeps the adapter describes
  (`runArgs`, `runnerPrompt`, `runnerSpawnReq`).
- Output contract: the FSM is a pure move — `run <mol>` verdict lines,
  `say()` lines, and `--json` rows are byte-identical by construction;
  `convoy.test.ts` dispatch coverage unchanged.
- Import audit: `grep -rn "commands/\|plugins.ts" packages/rig/src`
  stays empty; `packages/rig` calls no `process.exit`.
