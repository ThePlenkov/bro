# bro-qjji2.10 — pipeline: production run-starter — queue → runPipeline + run.customer + formulaSha + prod engine map

Parent: specs/bro-7d5nb.md (the agile pipeline contract — stages,
transitions, customer channels, concurrency). Sibling boundaries:
bro-qjji2.12 owns the fleet `work` engine's real worker spawn (merged
#999); bro-v0pvd.2 owns the `act-gate` merge-stage factory (merged
#1002); bro-v0pvd.3 owns the run waker — journal scan →
`resumePipeline` on settle (its own branch; this bead ships ONLY the
fresh-start/admission side and must not grow a second resume loop);
bro-qjji2.11 owns the production accept `emit` transport (this bead
binds the emit SEAM, not the transport). The gap the 2026-11-11 audit
recorded: `runPipeline` has zero production callers — only tests and
`scripts/pipeline-live-e2e.mts`. Every stage is machinery without a
driver. This bead ships the driver: the thing that picks queued items,
resolves the recorded customer, binds the production engine map, stamps
`formulaSha`, and invokes fresh `runPipeline` runs safely.

## What "the queue" is

The pipeline item is a bead id — the journal rows, the taskSpec facade,
and the fleet spawn's `molStep` all key on it. "Queued items" are the
beads the operator has marked for pipeline processing: **ready beads
carrying the `pipeline` label**, read through the same `readyBeads`
contract `bro next`/`bro loop` use (`@broject/rig` → `TaskStore.ready`,
`gt:slot` coordination beads already excluded). The label is the
explicit opt-in — parallelism is declared, never assumed, the same
posture the formula's serial `in_flight` default takes. Explicit items
may also be named on the command line to run a specific bead regardless
of label.

A ready bead is a *candidate*, not a commitment: dedup (below), the
occupancy semaphore, and admission all still apply. Labeling a bead
`pipeline` queues it; it does not guarantee immediate execution.

## The command — `bro pipeline run`

A new subcommand on the existing `bro pipeline` group (the group is
already the pipeline's CLI surface — `accept`/`answer` write the
customer channel, `run` creates the runs that channel feeds):

```
bro pipeline run [--formula <file>] [--engines <module>]
                 [--customer <id>] [--label <label>] [--limit <n>]
                 [--dry-run] [--json] [<item>…]
```

- `<item>…` / `--item <id>` — explicit bead ids to start (repeatable);
  bypasses the label scan but NOT dedup/admission/occupancy.
- No positional items → scan the ready queue for `--label` (default
  `pipeline`) beads.
- `--formula <file>` — REQUIRED. The pipeline formula (TOML) every run
  stamps and drives. There is no default formula path: the operator
  names the contract, matching how `--engines` names the engine map.
- `--engines <module>` — optional path to a module exporting `engines`
  (an `EngineMap` or a `(dir) => EngineMap` factory — the same
  convention the waker's `--engines` already loads). Absent → the
  built-in production map (§engine map).
- `--customer <id>` — override the recorded customer (§customer).
- `--label <label>` — the queue label to scan (default `pipeline`).
- `--limit <n>` — cap how many NEW runs this invocation starts
  (default: all candidates; the occupancy semaphore queues the rest).
- `--dry-run` — resolve queue, customer, formula, dedup; report what
  WOULD start without invoking `runPipeline`.
- `--json` — machine-readable report.

The command runs each candidate SEQUENTIALLY (`await` each
`runPipeline`): `runPipeline` drives a run to its first park/halt, and
serial starts keep the journal-plane occupancy reads honest — two
concurrent fresh runs could both pass the `in_flight` check before
either journals a moving row.

## run.customer — the acceptance authority, resolved never derived

`run.customer` is the identity allowed to sign `accept` — the
acceptance authority. It is resolved ONCE per invocation, before any
run starts, with this precedence:

1. `--customer <id>` — explicit.
2. `BRO_CUSTOMER` env — the deployment's recorded customer.
3. `bdActor(dir)` — the store's actor chain (the operator identity
   `bd --claim` attributes work to).

`BRO_AGENT_ID` is deliberately NOT in the chain: it is the *running
agent's* badge, and letting it default the customer would let whatever
worker happens to invoke `run` become its own acceptance authority —
the self-acceptance hole the customer gate exists to close. An
agent-customer deployment sets `BRO_CUSTOMER` or passes `--customer`
explicitly. The resolved value MUST equal the identity the customer
later presents at `bro pipeline accept` (`--by`, else that command's
own `BRO_AGENT_ID → bdActor` chain) — for the common human-operator
case the `bdActor` default already matches; an agent-customer is
configured to match on both sides.

An unresolvable customer (empty after the whole chain) is a hard fail:
the command reports `customer-unresolved` and starts NOTHING — a run
whose accept gate can never be signed is worse than no run. This is
the same fail-closed posture `bro pipeline accept`'s `signer()` takes
("a verdict with no signer can never pass the gate").

## formulaSha stamping + the sidecar

`runPipeline` REQUIRES `opts.formulaSha` (runner.ts — `''` disables
drift detection and is rejected). The starter loads the formula once
per invocation via `loadPipelineFormula(file)` → `{formula, sha}` —
`sha` is `formulaSha(rawBytes)`, SHA-256 over the raw TOML bytes, no
canonicalization. Every `runPipeline` call gets `formulaSha: sha`, so
every journal row carries the run's formula identity and resume's
drift check has its baseline.

After each `runPipeline` returns its `RunResult.runId`, the starter
writes `<git-common>/bro/pipeline/<runId>.formula.toml` — a byte-exact
copy of the formula file. This is the creation convention the waker
(bro-v0pvd.3) already reads: `formulaFor` prefers the run's sidecar,
then sha-matched files under `--formula-dir`. Writing it at creation
means a later `bro pipeline wake`/`pipelineWakePass` can resolve the
run's formula without the operator re-supplying `--formula`. The
sidecar is best-effort: a write failure is reported on the run's row
but does not fail the run (the waker's `--formula-dir` fallback still
serves it).

## Dedup — never double-start a live run

`run_id ↔ item` is 1:1, but nothing stops a SECOND `runPipeline` for
the same item minting a fresh `runId` and racing the first. Before
starting item X the starter scans the pipeline plane
(`<git-common>/bro/pipeline/*.journal.jsonl`) and asks: does X already
have a LIVE run? A run is live unless its seq-collapsed tail settles to
a terminal-done action — `end`, `close`, or `abandon` under
`transitionFor(formula, stage, verdict)`. Everything else is live:
a verdict-less intent (pending/crash window), an `alert` row (fail-closed
park), a `park`/`retry`/stage transition (the waker owns resuming it).
This is the waker's `classifyAnchor` "finished → undefined" rule applied
as a boolean — the starter does not resume anything, it only declines
to create a duplicate. Existing runs are the waker's jurisdiction; the
starter never calls `resumePipeline`.

The scan classifies each existing run's tail against the CANDIDATE
formula (all production runs share the one formula; a drifted older
formula's tail could misclassify, and the conservative direction —
treating ambiguous as live — only ever skips, never double-fires).

## Admission, leases, and maxInFlight — passed through, never bypassed

The starter adds NO new admission path; it binds the runner's existing
seams:

- `opts.dir` → the file journal under the git common dir AND the
  occupancy plane (`occupancyDir`). The runner's own semaphore —
  `limits.in_flight` narrowed by `opts.maxInFlight`, plus per-stage
  `concurrency` — reads every `*.journal.jsonl` and parks
  `stage-saturated` at a stage door when the cap is hit. That park is
  the queue: the waker re-enters it when an occupant's verdict frees
  the lane. The starter relies on this entirely — it does not
  pre-count or pre-park.
- `opts.maxInFlight` → the machine budget (`fleet.maxConcurrent`-style
  narrowing), passed through from `--max-in-flight`/config when bound.
- `opts.admit` → the go-marker seam. Bound to `() => true`: a fresh
  invoke is always admitted to ATTEMPT the spawn-like side effect;
  detailed admission (fleet cap, registry go-marker, occupancy,
  external-agent guard) lives inside `spawnStepAgent`, which the fleet
  engine's `deps.spawn` calls — a refusal surfaces as the stage's own
  `SpawnError → SATURATION_ALERT`/crash verdict, journaled and
  resumable. The journal intent + the engine `recheck` hook own
  crash-window idempotence; `admit` is only the fresh-invoke gate.
- `opts.customer`, `opts.formulaSha`, `opts.engines`, `opts.dir` —
  as above.

A bead already claimed/in-progress is still a valid pipeline item (the
pipeline works in its own worktree via the fleet spawn; it does not
take the bead claim). Dedup is by RUN, not by bead status — the live-
run scan is the authority on "already owned".

## The production engine map

`packages/cli/src/pipeline-engines.ts` exports `engines` — a
`(dir) => EngineMap` factory (the `--engines` module contract AND the
`bro pipeline run` default). It binds all seven slots the spec formula
uses, keeping `@broject/pipeline` provider-agnostic — every host seam
is injected:

- **`judge`** (classify/route/review) — `stageDispatch` over
  `classifyStage`/`routeStage`/`reviewStage`. Deps: `judgeFacade(dir)`
  (`@broject/judge`), `taskBacklog(taskStore(dir))` (the prod backlog
  factory the stage files name), `routing`/`providers` from
  `loadAgentEnv(dir)`, `occupancy` → `{live: fleetOccupancyFor,
  cap: fleetCapOf}`, `walls` → `deriveProviderWalls(readAgentRegistry,
  …)`, review's `diff` → a git seam over the worker worktree.
- **`intake`** — `intakeStage({taskSpec: taskSpecFacade(taskStore(dir)),
  answers: fileAnswerFeed(dir), intake: <DoR judgment>})`. The
  judgment is a `judgeFacade.decide` call over the spec's acceptance
  criteria → `accepted|questions|declined`.
- **`fleet`** (work) — `workStage({spawn, observe, diff, pipeline,
  lane})`. `spawn` adapts `spawnStepAgent` (connector/provider/
  worktree/claim/registry/caps all its own); `observe` reads the agent
  registry/connector status keyed by `call.item`; `diff` reads git
  over the recorded worktree; `pipeline` carries `{formula, formulaSha,
  stage}` provenance (the BRO-Formula trailer .12 stamps).
- **`e2e`** (verify) — `verifyStage({taskSpec, e2e})`. The per-AC
  evidence seam: prod has no agentic e2e runner yet — the default
  binding answers each AC with an honest `fail`-free refusal is NOT
  acceptable (a `fail` verdict loops `work` forever; a `pass` verdict
  fakes verification). The default `e2e` THROWS
  `no e2e runner bound — inject engines via --engines`, so the pending
  intent is the crash marker and the run parks `attempts-exhausted`
  for an operator, never silently green. A real runner is future work
  (operator-injected today via `--engines`).
- **`accept`** — `acceptStage({emit, verdictStore:
  fileVerdictStore(dir)})`. `verdictStore` is the durable customer
  channel. `emit` surfaces the evidence bundle on the customer channel
  — the default binds `dropMailbox`/notify (user → mailbox; the spec's
  named channel for a human customer) keyed by runId for idempotence
  (`recheck` re-emits while the verdict is absent — the channel MUST
  dedupe on `(runId, stage)`). The full emit TRANSPORT (A2A surface,
  rich notify) is bro-qjji2.11; this bead lands the seam.
- **`act-gate`** (merge) — `actGateStage({probe})`. The probe adapts
  `fetchPrActState` + `evaluateExitGate` + `gatePending` (`@broject/act`)
  into the normalized `ActGateObservation` the stage contract names —
  read-only, idempotent, `undefined` only for "no PR at this ref".
- **`learn`** (capture) — `captureStage({capture, retro})`.
  `capture` adapts `captureLessons` (`@broject/learn`) —
  `CaptureReport → CaptureOutcome`; `retro` records the batched-retro
  intent (queues, never executes — the spec forbids a per-item
  heavyweight retro inside the stage).

`--engines <module>` replaces the WHOLE map (the waker's contract) —
an operator shipping a real e2e runner or a different emit supplies
their own `EngineMap`/`(dir)=>EngineMap`; there is no per-slot merge.

## The starter — `packages/pipeline/src/starter.ts`

Provider-agnostic orchestration, exported from `@broject/pipeline`:

```ts
startRuns({
  dir, formula: {formula, sha}, customer, engines,
  items: string[], admit?, maxInFlight?, ctx?,
  runPipeline?,            // test seam — default the real one
  writeSidecar?,           // test seam — default the .formula.toml write
}): Promise<StartReport>
```

For each item, in order: dedup-scan → skip `already-running` →
`runPipeline(formula, item, {dir, customer, formulaSha: sha, engines,
admit, maxInFlight, ctx})` → on `RunResult` write the sidecar → record
`{item, runId?, outcome, stage, alert?, action}` where action ∈
`started | already-running | failed`. A `runPipeline` THROW is caught
per item → `failed` (one bad item never blocks the queue). The report
is what `--json` prints and what `--dry-run` would have produced minus
the `runPipeline` calls.

`liveRunItems(dir, formula)` is the dedup scan — `*.journal.jsonl` →
group rows by item within each run_id → `journalRecords` seq-collapse →
tail → live unless `transitionFor` lands `end|close|abandon`. Lives in
the pipeline package beside the journal it reads; the waker's
`scanPipelineRuns`/`classifyAnchor` (bro-v0pvd.3) is the resume-side
counterpart — this is deliberately the smaller boolean, not a second
copy of the anchor taxonomy.

## Boundary vs bro-v0pvd.3 (the waker)

This bead owns queue→FRESH-`runPipeline` only. It does NOT scan for
resumable runs, does NOT call `resumePipeline`, does NOT implement the
wake cadence or its lock — `bro pipeline wake`/`pipelineWakePass`
(bro-v0pvd.3) own journal-scan→resume. The two meet at exactly one
artifact: the `<runId>.formula.toml` sidecar this bead writes at
creation is what the waker's `formulaFor` prefers when resolving a
parked run's formula. The occupancy semaphore (`stage-saturated` parks)
is the hand-off: the starter creates runs that queue behind
`in_flight`; the waker resumes them as lanes free.

## Test plan

`packages/pipeline/src/starter.test.ts` (injected `runPipeline` spy +
`memoryJournal`/tmp pipeline dirs):

- empty queue → empty report, no `runPipeline` calls.
- queue item → `runPipeline` invoked once with `customer`,
  `formulaSha`, `dir`, `engines`; sidecar written at
  `<runId>.formula.toml`.
- `formulaSha` is the loaded formula's sha on every call (drift
  baseline present, never `''`).
- customer-resolution failure (CLI layer) → command reports
  `customer-unresolved`, zero `runPipeline` calls.
- an item with a live journaled run → `already-running`, no second
  `runPipeline`; a terminal (`end`) run → NOT skipped.
- `runPipeline` throw → `failed` row, queue continues.
- `--dry-run` → report without invoking.
- `admit`/`maxInFlight`/`ctx` pass through to `RunOptions`.

`packages/cli` command tests: queue scan picks `pipeline`-labeled
ready beads only; explicit items bypass the label; `--limit` bounds;
`--customer`/`BRO_CUSTOMER`/`bdActor` precedence; `--engines` module
loads an `EngineMap` or `(dir)=>EngineMap`.

Engine-map tests: `engines(dir)` returns all seven slots; judge slot
is a `stageDispatch`; accept's `verdictStore` is `fileVerdictStore`;
fleet's `spawn` adapts `spawnStepAgent` (refusal → the stage's own
verdict path); act-gate probe maps `fetchPrActState` observations onto
`ActGateObservation`.

## Docs / contract

- `plugins.ts` pipeline `contract.subs` gains `run` (flags + exits).
- `contract/cli.json`, `site/content/docs/reference/pipeline.md`
  regenerate via `gen:contract`/`gen:command-docs`.
- `site/content/docs/` pipeline guide notes the queue label + customer
  resolution if a page exists for the group.
