# bro-v0pvd.3 — pipeline: run waker — journal scan → resumePipeline on settle (PR / customer / wall)

Parent: specs/bro-7d5nb.md (pipeline formulas — write-ahead journal,
customer channels, park/resume semantics). Epic: bro-v0pvd (the
"global watcher pipeline" — this bead is its RESUME half; admission
is bro-qjji2.10's, still unstarted). Sibling seams: bro-v0pvd.2's
act-gate engine (PR #1002 in flight — its `gate` intent + idempotent
recheck is the anchor this waker will probe once it lands); the
prod engine map is bro-qjji2.10's — this bead ships the scan +
wake-condition + resume mechanics and takes engines/formula through
an injected resolver, never a second driver.

## Gap

`runPipeline`/`resumePipeline` have zero production callers. A run
parks — accept's `emit` awaiting a customer verdict, intake's
`questions` awaiting answers, route's `queue` awaiting a wall/slot,
a stage-saturated door, a crashed-mid-drive tail — and nothing
re-drives it: `bro pipeline accept|answer` writes the customer
record, then the run sits until someone resumes by hand. The
discovery pattern exists (`awaitingCustomerRuns` scans
`*.journal.jsonl` for customer-gated runs); this bead generalizes it
to EVERY resume anchor and adds the wake conditions + cadence owner.

## Design — `packages/pipeline/src/wake.ts`

Script-first, provider-agnostic, no agent. One pass:

```text
scan *.journal.jsonl → per (run,item) tail → resolve run spec →
classify anchor → wake-condition probe → sig check → resumePipeline
```

### Scan — every resume anchor, journal-derived

`scanPipelineRuns(dir)` reads `<git-common>/bro/pipeline/` once per
pass (the same plane `flowTails` reads for occupancy — the scan IS
the semaphore view). Each `*.journal.jsonl` groups rows by `item`
(run_id↔item is 1:1 by contract; grouping defensively keeps a mixed
file from hiding a park), collapses by `journalRecords`, and takes
the tail. A view carries `{runId, item, journalPath, journal,
formulaSha, customer, tail, records}`.

Anchor classification needs the formula (a settled tail's
`transitionFor` decides park-vs-terminal-vs-mid-drive), so
classification runs AFTER resolution:

| tail shape                                   | anchor     | wake rule                          |
| -------------------------------------------- | ---------- | ---------------------------------- |
| `alert` row                                  | `alert`    | signal-bearing alerts only (below) |
| verdict-less (`pendingRecord`)               | `pending`  | per intent word (below)            |
| settled → `park`                             | `parked`   | per stage engine + verdict (below) |
| settled → stage name / `retry` / no target   | `resume`   | ALWAYS — crash-mid-drive, the      |
|                                              |            | runner never finished the drive    |
| settled → `end`/`close`/`abandon`            | —          | done, never a candidate            |
| `tail.formula_sha ≠ resolved sha`            | —          | drift is an operator decision; the |
|                                              |            | waker never auto-acks it           |

`resume` covers the crash window between a verdict append and the
next intent — unfinished drive work, always wake-eligible (the
runner's own bounds — maxSteps/maxAttempts — still apply).

### Wake conditions — "the awaited input MAY have settled"

The waker never simulates engines; it wakes when the plane shows a
signal, and `resumePipeline` + `recheck` arbitrate (write-ahead
contract: the runner never blind re-fires — a `pending` recheck
re-parks with no journal write).

- **`pending` intent `emit`** (accept's customer wait): wake when
  the run's customer channel holds a verdict candidate
  (`latestVerdict`) — malformed ones count, the gate's fail-closed
  alerts are the repair path. PLUS a slow re-emit cadence: a pending
  emit whose anchor is older than `reemitMs` (default 30 min,
  injectable) wakes anyway — the emit may have died inside the
  crash window and the customer never saw the bundle; accept's
  recheck re-emits idempotently on an empty store. Age is
  bucketed (`floor(age/reemitMs)`) into the sig so the cadence
  fires once per interval, never per tick.
- **`pending` intent `gate`** (act-gate's PR probe): wake iff
  `probes.prSettled(view)` answers true. No probe bound → the anchor
  is skipped entirely — PR #1002's engine + the act package own the
  settle semantics; the seam is `prSettled`, documented for the
  follow-up. (The bead's "journal mtimes for non-PR anchors" — PR
  anchors simply have no mtime signal; they wait for the probe.)
- **`pending` intent `spawn`**: the decision always fires; the sig
  carries the agents-registry fingerprint (computed once per pass,
  shared across spawn-pending runs) — net effect: one wake per
  registry change. A worker exit IS a registry write; any other
  churn only costs a cheap recheck→pending re-park (no journal
  writes). A hook-less spawn halts `recheck-unavailable` with NO
  row — the intent stays the anchor and keeps deduping until the
  fingerprint moves or .10 wires the fleet recheck hook.
- **`pending` other intents** (`judge`/`spec`/`verify`/`capture`):
  synchronous engines — a verdict-less tail is a crash mid-invoke.
  ALWAYS wake; the bounded re-fire/attempt budget is the contract.
- **`alert` — customer-repairable** (`verdict-malformed`,
  `verdict-forged`, `customer-mismatch`, `fix-notes-missing`,
  `answer-malformed`) at an accept/intake stage: wake when the
  channel shows input NEWER than the alert — any record whose `ts`
  parses after the alert row's `ts`, or any record with missing/
  unparseable `ts` (can't prove stale → wake; the gate validates).
  Content decides, never file mtime. A corrected record is exactly
  this signal; the bad record that caused the alert predates it.
- **`alert` — `stage-saturated`**: wake when the journaled
  occupancy says a slot may be free — the SAME `flowTail` semantics
  the runner enforces, computed across every scanned run with the
  candidate's own formula: `moving < in_flight` AND the resume
  stage's holders `< min(stage.concurrency ?? in_flight, in_flight)`
  (machine `maxInFlight` narrows via the resolved opts). Occupancy
  is journal-derived — a sibling's verdict freeing the slot IS the
  wake, no probe needed.
- **`alert` — everything else** (`formula-drift`,
  `gate-indeterminate`, `engine-unavailable`, `admission-unavailable`,
  `recheck-unavailable`, `fix-notes-missing` on review,
  `fix-rounds-exhausted`, `attempts-exhausted`, `missing-transition`,
  `cycle-exhausted`, `item-mismatch`, engine-local tags): the world
  must be repaired by an operator or a config/code change the
  journal plane can't see — NEVER auto-wake. `resumePipeline` by
  hand stays the operator tool.
- **`parked` — intake `questions`**: wake when `pendingAnswers` over
  the channel yields ≥1 answer candidate (`kind:"answer"` or a
  kind-less row carrying `answers` — intake's own admission rule).
  Verdict/consumed rows don't count: waking on those would re-run
  the judgment seam for nothing.
- **`parked` — route `queue`**, by payload `reason`:
  - `onwall` → wake when the wall's provider
    (`payload.wall.provider ?? payload.provider`) is absent from
    `probes.walls()` — prod binds `deriveProviderWalls` over the
    agents registry. It parked waiting on ONE wall; that wall
    lifting is the signal.
  - `chain-spent` → the wake re-walks the whole chain, so ANY
    improvement counts: no walls left, or the recorded would-be
    slot (`payload.provider`) un-walled. (A wall lifting on a chain
    member the payload doesn't name stays invisible to v1 — the sig
    still re-evaluates on every wall-set change.)
  - `saturated` → wake when `probes.fleetLoad()` (the RouteLoad
    shape `{live, cap?}` — prod binds `fleetOccupancyFor` +
    `fleet.maxConcurrent`) shows `cap > 0 && live < cap`, or the
    load is uncapped (a saturated park under no cap is stale — the
    wake re-queues or dispatches).
  - `timing` → skip — the judge's "later" has no journaled signal.
- **`parked` — everything else** (classify/route `defer`, verify
  `unverifiable`, unknown verdicts): operator decisions — skip.

### The sig gate — idempotent across crashes AND ticks

Every evaluated decision hashes its INPUTS — `{anchor, channel
rows, walls, occupancy snapshot, registry fingerprint, pr probe,
fleet slot, age bucket}` — into `<runId>.wake.json` (tmp+rename,
the want-marker pattern; per-run file holding a per-item map).

- Same inputs next tick → same sig → skip, no resume, no probe
  calls beyond the shared per-pass reads. This is what makes
  "pending emit, no verdict yet" free (never wakes, never re-emits)
  and "consumed verdict resubmitted identically" settle after ONE
  wake instead of looping.
- Inputs changed → sig differs → re-evaluate → maybe wake.
- Lost/corrupt sidecar → treated as no record → one redundant wake;
  the runner's contracts (consumed-verdict echo, `forgedAlready`,
  `pendingRecord`+recheck) absorb it. The journal stays the only
  resume truth — the sidecar is a dedup hint, never state.
- Resume THROWS → sidecar records `{sig, failed:true}`; the sig
  match requires `!failed`, so the next pass retries (transient
  engine faults heal; a persistently broken engine retries per tick
  exactly like drive's per-PR error verdicts).

### Serialization — one waker per repo

`<pipelineDir>/wake.lock` via `holdFileLock` with `waitMs: 0`
(try-lock + heartbeat — a resume can outlive the 15-min abandoned
bound). A second waker (daemon tick vs manual `bro pipeline wake`)
gets `LockTimeout` → reports `locked` and exits — concurrent wakers
can never double-fire: even if one slipped past, the runner's own
`pendingRecord`+recheck contract is the second layer (and
`fileJournal`'s read-once mirror means two live runners on one file
is the documented hazard the lock exists to prevent).

### Resolution seam — formula + engines are caller-supplied

The journal records `formula_sha`, never the formula or the engine
bindings — run creation is bro-qjji2.10's. `wakePipeline` therefore
takes `resolve(view) → ResolvedRun | undefined` — `{formula, opts}`
where `opts` is `Omit<RunOptions,'journal'|'runId'>` carrying
`formulaSha`, `engines` and the rest verbatim (the waker owns
`journal` and `runId`: a FRESH `fileJournal` per wake, the
read-once mirror contract). undefined = can't serve this pass (retried next tick,
never stored in the sig). `customer` passes through only as the
journal-silent fallback — `bindCustomer` inherits the journaled
identity first and a conflict fails closed inside the runner.

CLI binding (`bro pipeline wake`, and the drive tick):

- formula: `<runId>.formula.toml` sidecar in the pipeline dir (the
  convention .10's starter writes), else `--formula <path>` for all
  candidates, else `--formula-dir <dir>` scanned for a
  `formulaSha(bytes)` match. Unresolvable → `unresolved`, quiet.
- engines: `--engines <path>` dynamic-imports a module exporting
  `engines` (EngineMap or `(dir) => EngineMap`) — overrides the
  built-in production map wholesale; a module exporting no map
  leaves every run `unresolved`. Absent → the production map binds
  per (formula file, sha) — the .10 engine map, resolved per run —
  and the drive tick shares the same binding.
- probes: `walls` = `deriveProviderWalls(readAgentRegistry(dir),
  now, providers)`; `fleetLoad` = `{live: fleetOccupancyFor(dir, env),
  cap: fleetCapOf(env)}`; `prSettled` unbound (seam only). No `admit`
  seam is bound either — a resumed run reaching a spawn intent parks
  `admission-unavailable`, .10's boundary, fail-closed by design.

### Cadence owner — the drive pass

`bro pipeline wake [--json]` is the standalone one-pass command
(manual/cron/script use — takes no supervisor lock itself beyond
`wake.lock`). `driveOnce` calls `pipelineWakePass(ctx.mainRoot)` —
the shared deps builder `cmdWake` also uses, minus the CLI flag
bindings — beside `litterSweep`/`herdrProjectorTick`: the daemon's
`--every` cadence owns the wake pass long-term, and `wake.lock` is
the waker's own guard against a concurrent manual pass (drive.lock
is NOT taken by the standalone command). Tick cost when nothing is
parked: one readdir + journal tails. When runs are parked: sig-gated
probe reads + rare resumes. A resume's engine time shares the pass —
stage engines are built non-blocking (`pending` suspends), and .10's
map owns the heavy seams. Tick failures warn, never fail the pass.

## Acceptance mapping

- `bro pipeline accept` verdict → next wake settles the gate: the
  emit-pending anchor wakes on the channel's verdict candidate;
  `recheck` settles/alerts — hermetic test drives exactly this.
- stage-saturated / onwall / chain-spent parks wake when the
  slot/wall frees: occupancy is journal-derived (sibling verdict =
  the signal); walls come from `deriveProviderWalls`.
- Idempotent across crashes: journal is state; sidecar is a dedup
  hint whose loss costs one redundant wake the runner absorbs;
  `wake.lock` + the runner's recheck contract prevent double-fire.
- No agent: pure script/daemon code — the only agent work a wake can
  trigger is INSIDE a stage engine (intake's judgment, fleet's
  spawn), which is the pipeline doing its job, not the waker.

## Boundary vs bro-qjji2.10

.10 owns ADMISSION (queue → runPipeline for new items, run.customer,
prod engine map, formulaSha stamping — including the
`<runId>.formula.toml` sidecar convention this waker reads). This
bead owns RESUME for already-journaled runs only. If .10's
implementer folds admit+wake into one driver loop, this module is
the wake half it calls — the scan/decide/sig machinery stands alone
either way. No queue→runPipeline code lives here.
