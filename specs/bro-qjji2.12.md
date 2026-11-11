# bro-qjji2.12 — pipeline: fleet work engine — real worker spawn for the fleet slot

Parent: specs/bro-7d5nb.md (pipeline formulas). Sibling boundary:
bro-qjji2.10 owns the production run-starter (queue → `runPipeline`,
`run.customer`, the prod engine map, `formulaSha`) — this bead ships
the `fleet` slot's factory that map binds. bro-v0pvd.2 owns the OTHER
missing factory (`act-gate`); no overlap.

## Problem

The formula's `work` stage declares `engine = "fleet"` with verdicts
`done|rate_limited|crash|stopped`, but `packages/pipeline/src/stages/`
has no fleet/work factory — the engine exists only as test spies and
the e2e script's inline stub. Until a real `EngineHandler` binds the
slot, every formula that reaches `work` parks `engine-unavailable`:
the spawn side of the pipeline is machinery without a worker.

## Design

`workStage(deps)` in `packages/pipeline/src/stages/work.ts` — an
`EngineHandler` for the runner's `fleet` slot, same factory shape as
classify/route/intake/verify/review/accept/capture. The engine owns
the spawn request, the exit→verdict mapping, and the work payload;
everything provider- and store-facing stays behind injected seams.

### Lifecycle — spawn is async, the journal is the resume anchor

A worker outlives any single runner wake, so the stage never blocks
on it — it uses the runner's spawn-intent contract verbatim:

- `invoke` builds the {@link FleetSpawnRequest} from the call (item,
  route-stage ctx fields, fix scope, pipeline provenance) and fires
  `deps.spawn`. It then takes ONE observation (`deps.observe`) and
  answers through the same mapper `recheck` uses: live worker →
  `'pending'` (the runner parks WITHOUT a verdict row — the spawn
  intent stays the resume anchor); already-terminal → the verdict
  settles in the same wake, so an instant death never waits for an
  external wake.
- `recheck` observes only — it NEVER re-fires. `undefined` observation
  attests "the spawn never landed" → the runner's bounded refire
  (attempt+1, go-marker re-consulted); live → `'pending'`; terminal →
  settle the pending record with the same verdict+payload `invoke`
  would have produced. This is what makes the verdict-less spawn
  intent safe to resume: the registry, not the journal, answers
  whether the side effect landed.

### Exit → taxonomy — core's classification, verbatim causes

The observation seam returns core's `AgentInfo` — `state` +
`cause`/`resetAt` are the output of `classifyExitCauseParts` over the
worker's log tails, harvested by the connector (the registry's own
machinery — the engine classifies nothing itself):

| observation                    | verdict          |
| ------------------------------ | ---------------- |
| `spawned` / `running`          | `'pending'`      |
| `stopped` (operator `down`)    | `stopped`        |
| `lost` (dead, no record)       | `crash`          |
| `exited`/`blocked`, cause `ok` | `done`           |
| cause `rate_limited`/`quota`   | `rate_limited`   |
| cause `crash`/`auth`/absent    | `crash`          |

`blocked` reads by cause like `exited`: the worker already died — the
state only records that its wall still holds for respawn, and the
`rate_limited` verdict re-enters `route`, whose `onWall` chain owns
the wait (park until reset / fallthrough). `quota` maps to
`rate_limited` deliberately: `deriveProviderWalls` classes it a
provider wall beside `rate_limited`, and `crash → retry` would burn
the attempt budget spawning into a wall the chain should route
around. `auth`/`crash`/unclassified are worker-side failures →
`crash` (bounded retry, then park — fail closed, never a silent
pass).

### Spawn refusals — the world answers, the engine maps

`deps.spawn` throws `SpawnError` (core):

- `kind === 'cap'` — the machine budget (`fleet.maxConcurrent`,
  `agents.<kind>.maxBatchWorkers`) refused under the spawn lock. The
  stage's own occupancy was already admitted, so this is a capacity
  wait, not a failure: the engine answers the runner's
  capacity-wait park (`SATURATION_ALERT`, `resume` = the stage) — a
  wake re-enters and re-spawns, no attempt burned. It is NOT
  `rate_limited`: that verdict re-enters `route`'s wall path and
  would advance the provider chain past a healthy lane.
- `kind === 'conflict'` — a live agent already owns the step (the
  fleet registry IS the dedup plane): `deps.observe` shows
  `spawned`/`running` → `'pending'`, this run attaches to the worker
  already doing the item's work and settles on its exit. Any other
  observation → rethrow (a claim-side refusal with no live worker is
  a real conflict → crash marker → bounded retry → park).
- everything else (`input`/`config`/`unavailable`, non-SpawnError
  throws) → propagate: the pending intent is the crash marker, the
  bounded re-fire is the retry.

### Composition — admit go-marker + the in-flight semaphore

Nothing here re-implements them; the engine is built to live inside
them:

- the `work` stage's intent is `spawn` (`STAGE_INTENTS.fleet`) — a
  member of `DEFAULT_ADMIT_INTENTS`, so the runner consults the
  bound `admit` seam (the go-marker protocol) BEFORE `invoke` runs;
  an admit `EngineResult` settles the stage without the engine ever
  firing (refusal detail journals `admit: true`, never enters ctx).
- journaled occupancy IS the semaphore: `limits.in_flight`, the
  machine `maxInFlight`, and stage `concurrency` are all checked by
  the runner before the engine is invoked — a `done` worker's exit
  frees the stage seat and the in-flight lane on its verdict
  transition, which is also what wakes saturated siblings.
- the machine cap the journal can't see (`fleet.maxConcurrent`)
  surfaces inside `deps.spawn` as the `cap` refusal above.

### The spawn request — routing in, scope through, no worker text

`FleetSpawnRequest` carries `molStep` (= `call.item` — the item IS
the fleet step/claim key), `lane` (default `'batch'` — pipeline work
is fleet-owned batch work), the route stage's journaled routing
fields read back out of `call.ctx` (`provider`, `model`, `class`,
`kind`, `orch` — flat-merged route payload, strings only), the
scoped-fix pair (`fixRound`, `notes` — the runner's re-entry
contract), and `pipeline` provenance.

The engine writes NO worker-facing text (spec invariant 1 — agents
never see pipeline mechanics): prompt composition belongs to the
seam. On a scoped re-entry the seam renders `notes` into the fix
instructions against the SAME worktree (`resolveWorktree` reuses the
recorded checkout — resume semantics the registry already owns).

`pipeline` provenance is `{formula, formulaSha, stage, sessionId?}` —
the `PipelineProvenance` the registry stamps (`formula`,
`formula_sha`, `pipeline_stage`, `session_id`) and the `BRO-Formula`
pin feeds. `formulaSha` resolves deps-first, then the run's journaled
`formula_sha` (every row carries it — `RunOptions.formulaSha` is
required); `formula` comes from `deps.pipeline.formula`. When no
honest sha resolves the `pipeline` field is OMITTED — provenance is
never fabricated (same rule as ad-hoc spawns). The request field maps
to `SpawnSpec.pipeline` — the registry/env pin path is already wired
in agent-connectors; the production binding owns forwarding it
(`StepSpawnRequest` does not expose it yet — `.10`'s adapter bridges
that seam, out of scope here).

### The work payload — nested provenance, diff for the accept bundle

`FleetPayload` merges into ctx flat AND under the stage name:

- `worker` — `{agentId, backend?, provider?, model?, class?}` NESTED,
  never flat: route's payload owns the flat `provider`/`model`/`class`
  keys, and a flat restate would flip their meaning mid-pipeline
  (review's `reviewer` slot set the precedent).
- `worktree`, `cause` (core `AgentCause` verbatim), `resetAt`,
  `fixRound` (restated for journal readers — the row already carries
  it).
- `diff` — ONLY on `done`, from `deps.diff(call, worker)`: the
  provenance record `{files?, base?, head?, worktree?}` the accept
  stage's `evidenceBundle` lifts as its freshest `diff` field (spec
  §accept: `{verify rows, diff summary, draft_pr?}`). A `done` worker
  that changed nothing still settles `done` — `deps.diff` answering
  `undefined` journals no `diff`, and verify decides whether there
  was anything to check. Non-`done` verdicts carry no `diff`: a
  crashed attempt's partial tree is not acceptance evidence (the
  retry's `done` diff covers the cumulative worktree anyway).

### Seam contract

```ts
interface FleetDeps {
  /** fire the worker — prod binds the fleet spawn facade
   *  (spawnStepAgent over the agent-connectors seam: connector,
   *  provider, worktree, claim, registry, caps all theirs). */
  spawn(call: StageCall, req: FleetSpawnRequest): MaybePromise<AgentInfo>;
  /** the item's current worker — the registry/connector read keyed
   *  by molStep (= item). undefined = definitively no worker (the
   *  spawn never landed → refire); a READ FAILURE THROWS — an
   *  unreadable plane fails closed, never reads as absence. A
   *  superseding respawn's entry is the item's latest worker — its
   *  exit is the item's work verdict (the registry keeps the latest
   *  run per step). */
  observe(call: StageCall): MaybePromise<AgentInfo | undefined>;
  /** diff provenance after a `done` exit — prod binds git over the
   *  worker's recorded worktree. */
  diff?(call: StageCall, worker: AgentInfo): MaybePromise<FleetDiff | undefined>;
  /** formula identity for spawn provenance — formulaSha defaults to
   *  the journaled run sha */
  pipeline?: { formula: string; formulaSha?: string; sessionId?: string };
  /** spawn lane override — default 'batch' */
  lane?: 'batch' | 'interactive';
}
```

## Non-goals

- The production binding itself — `.10`'s run-starter owns the engine
  map (`spawnStepAgent` adaptation, `observe` over the agents
  registry/`conn.status`, `diff` over git). This bead ships the
  factory + contract only.
- Prompt/worktree/provider resolution — the spawn seam owns all of
  it (`resolveWorktree`, `resolvePrompt`, `resolveSpawnProvider`,
  `routeStepClass`); the engine passes fields, never resolves them.
- Waiting/polling inside the engine — wakes are the driver's; `pending`
  and `recheck` is the whole async contract.
- `act-gate`, `judge`, `learn` engines — sibling beads own them.

## Verification

- `packages/pipeline/src/stages/work.test.ts` — hermetic: scripted
  `spawn`/`observe`/`diff` fakes → the full taxonomy matrix
  (ok/rate_limited/quota/crash/auth/stopped/lost/live), spawn-request
  fields (routing ctx, fix scope, provenance), refusal mapping
  (cap→park, conflict+live→pending, else throw), `recheck`
  undefined/pending/settle, journal rows through `runPipeline`
  (intent `spawn` → verdict + payload; `done` carries `diff`, others
  don't; worker provenance nested).
- `npm run build`, `npm run typecheck`, `npm test` (pipeline package),
  biome on touched files.
