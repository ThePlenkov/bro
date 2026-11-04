# bro-7d5nb — pipeline formulas: declarative gate stages + traceability

Status: draft
Type: epic

## Problem

Work flows today through ad-hoc imperative paths: `bro loop` claims a
ready bead, spawns an agent, gates the PR. The decisions that surround
the work — WHICH item to run, with WHICH agent/model/orchestrator,
whether it deserves internal review, and what the run taught us — live
in flag defaults and conventions, not in a declared, versioned contract.
Two observable costs:

- **No intake intelligence** — plain priority/LIFO ordering ignores
  semantics: related tasks aren't grouped, duplicates aren't detected,
  and every item gets the same provider/model regardless of shape.
- **No backwards trace** — a commit/PR/branch cannot answer "which
  agent, model, session, and pipeline version produced me" without
  archaeology.

## Invariants (acceptance-contract level)

1. **Molecule = data, formula = data, interpreter = core code.** No
   pipeline logic in agent-facing artifacts — a worker prompt carries
   the task and repo facts only. The agent executes a step; the core
   moves pipeline state. Agents never see stage names, gate verdicts,
   or routing decisions.
2. **Provider-agnostic core.** The router emits a task *class* and
   *kind*; provider packages map class→provider/model. No
   provider-specific branching in shared paths.
3. **Durability on existing substrate.** Stage transitions journal to
   the stores we already trust: dolt (beads/molecules), agent registry
   (spawn/exit/verdict), git (artifacts). OTEL is observability only —
   never control plane, may be off.
4. **External workflow engines rejected** (Temporal, Mastra, …): the
   durable substrate exists; the gap is declarative composition, which
   is a spec + interpreter, not an engine adoption.

## Design

Two formula kinds, both TOML, both content-hash versioned:

- **proto formula** (exists) — work DAG: steps + `needs` edges,
  poured into a molecule. Describes *what* to build.
- **pipeline formula** (new) — stage DAG: named stages, typed
  verdicts, transitions. Describes *how* each work item flows.
  Rig-independent: lives in formula space, referenced BY a run —
  never poured INTO agent-facing artifacts.

```toml
version = 1

[[stages]]
name = "classify"          # G1: dedup, group, rank (judge)
engine = "judge"
verdicts = ["solo", "clump", "duplicate", "defer"]

[[stages]]
name = "route"             # G2: agent/model/orchestrator/now|queue
engine = "judge"
verdicts = ["spawn", "queue", "defer"]

[[stages]]
name = "work"              # spawn via fleet facade → exit taxonomy
engine = "fleet"
verdicts = ["done", "rate_limited", "crash", "stopped"]

[[stages]]
name = "review"            # G3: internal review — risk-gated
engine = "judge"
gate_on = "complexity == complex"   # cheap-class items skip
verdicts = ["push", "fix", "abandon"]

[[stages]]
name = "merge"             # act gate — threads/CI/reviewers settle
engine = "act-gate"
verdicts = ["landed", "blocked", "dropped"]

[[stages]]
name = "capture"           # G4: self-learn + plan next tasks
engine = "learn"
mode = "always-capture"    # per-item cheap; batch retro is separate
verdicts = ["captured"]

[transitions.classify]
solo = "route"
clump = "route"
duplicate = "close"
defer = "park"

[transitions.route]
spawn = "work"
queue = "park"
defer = "park"

[transitions.work]
done = "review"
rate_limited = "route"       # re-enter routing — honors onWall chain
crash = "retry"
stopped = "abandon"

[transitions.review]
skip = "merge"               # gate_on failed → bypass target
push = "merge"
fix = "work"
abandon = "abandon"          # review-abandon IS terminal failure

[transitions.merge]
landed = "capture"
blocked = "retry"
dropped = "close"

[transitions.capture]
captured = "end"
```

### Gates and the `skip` verdict — fail closed

`gate_on` evaluates against the pipeline context built from earlier
stage payloads, with THREE outcomes — never a silent bypass:

- **pass** — predicate true → the engine runs.
- **fail** — the field exists, is well-typed, and does not match → the
  runner synthesizes `skip` and follows that transition (no engine
  invoked).
- **indeterminate** — the field is ABSENT or malformed (a stage that
  should have produced `complexity` didn't) → `park` with a journal
  alert. A broken context never falls through to `skip`: the review
  gate cannot fail open.

`skip` is an implicit verdict: required in the transitions table for
every stage with `gate_on`, forbidden on ungated stages. This keeps
cheap-class bypass paths explicit — `done` still routes to `review`,
and `review`'s `skip` takes the cheap item to `merge` without running
the engine.

### Terminal actions

A transition target is a stage name or one of five runner actions —
declared here, not stages:

- `end` — terminal success; the run is complete, journal closes.
- `park` — suspend: item leaves the active set until capacity or an
  operator wakes it (resume re-enters at the same stage).
- `retry` — re-run the SAME stage, bounded by the runner's attempt
  budget (config `pipeline.maxAttempts`, default 3); budget exhaustion
  falls to `park`.
- `close` — terminal settle without failure (duplicate, dropped PR).
- `abandon` — terminal failure.

### Typed stage outputs

Verdicts are enum tags; every engine also emits a typed payload the
next stage reads:

- **classify** → `{ group: solo|clump|duplicate|defer,
  complexity: cheap|complex, rank: int }`. `complexity` is the typed
  field `review.gate_on` consumes — the gate is decided by classify's
  payload, not by re-judging.
- **route** → `{ class, kind, orch: acp|foreground|exec,
  timing: now|queue, provider?, model? }` — provider/model are
  resolved through `fleet.routing.<class>.chain` and `brouter`, never
  named by core.
- **work** → the registry exit taxonomy verbatim
  (`done|rate_limited|crash|stopped`); the verdict is a mapping, not
  a new enum.
- **review** → `{ verdict: push|fix|abandon, notes }` — the internal
  review pass on the worktree diff via `routing.review.chain`.
- **merge** → the act gate's settle state (`landed|blocked|dropped`).
- **capture** → `{ lessons: int, followups: [beadId] }`.

### Stage semantics

- **classify** — judge reads bead + repo signals; emits group/dedup/
  rank/complexity. LIFO remains tie-breaker INSIDE a group. Output
  lands as bead labels/claims, never in the prompt.
- **route** — judge emits `{class,kind,orch,timing}`; occupancy plane
  (`fleetOccupancyFor`) feeds the load signal. `queue` parks the item
  until capacity opens; `defer` is an operator verdict.
- **work** — spawn via facade → registry pins {pid, prompt, exit};
  `resolveWorktree` reuses recorded checkouts (resume semantics).
  `rate_limited` re-enters `route` rather than parking on the same
  chain entry: the route stage honors
  `fleet.routing.<class>.onWall` — `fallthrough` dispatches the next
  provider in the chain, `park` answers `queue`→`park`.
- **review** — internal pre-push pass via `routing.review.chain`
  (review-capable providers list). Risk-gated on classify's
  complexity verdict: `complex` required, `cheap` skips to merge.
  `fix` re-enters `work` in scoped-fix mode — the work stage runs
  against the SAME worktree with the review's `notes` payload as
  its scope input (a fix round), never a re-run of the original
  task. `notes` is required non-empty on `fix` — an absent or
  malformed payload fails closed: `park` with a journal alert, no
  scopeless re-entry. Each wave of findings is one scoped-fix
  re-entry, bounded by `pipeline.fixRounds` (default
  `act.maxRounds`, the loop contract); exhaustion `park`s the
  item rather than looping. `push` proceeds to merge.
- **merge** — the existing act gate: threads/CI/reviewers settle;
  `blocked` retries bounded by fix-rounds, `dropped` is terminal.
- **capture** — `self learn capture` on land (cheap, per-item);
  heavyweight session retro runs batched off-path.

### Write-ahead journal (resume correctness)

A stage's side effects are never the resume point. The runner
journals **intent** — `{run, step, stage, verdict?, attempt}` —
BEFORE emitting the side effect; the verdict field fills in after.
On resume: an intent row with no verdict means "side effect may or
may not have landed" — the runner re-checks the world (registry
admission/go markers for spawns, act markers for merges) rather than
blindly repeating. Spawn idempotence rides the existing registry
go-stamp protocol (an unadmitted survivor can never double a
respawn); the runner's retry is a fresh admission attempt against
that same marker, not a second spawn.

### formula identity

`formula_sha = sha256(<raw file bytes>)`. No canonicalization: two
byte-different files are two versions — formatting churn producing a
new sha is the honest answer (a comment IS a formula-version delta
worth tracing). The sha stamps registry entries and trailers.

### Traceability

Provenance stamps are **driver-attested hints, not self-certifying
facts**: a commit trailer naming a run proves nothing by itself —
anyone can write one. The authoritative trace is the keyed lookup:
`bro trace` resolves the chain and VERIFIES each hop against the
registry record.

- spawn → registry entry: `formula`, `formula_sha`, `session_id`,
  `pipeline_stage` (extends existing provider/backend/sessionKind)
- commit → trailers written by the DRIVER's commit path (the
  `BRO_*` env seam `prepare-commit-msg` already consumes — the
  driver sets them, a worker could fake them, and `bro trace`
  treats mismatch as forged-by-absence: trailer↔registry mismatch
  is reported, never silently trusted):
  `BRO-Run: <agentId>`, `BRO-Formula: <id>@<sha>`,
  `BRO-Session: <id>`
- PR → body footer: run/formula/session line
- `bro trace <commit|pr|branch>` — resolves
  branch→worktree→registry→agent→provider/model→formula@sha→mol
  step; reports VERIFIED on registry match, FORGED/MISSING on
  mismatch or absence

### Interpreter

A thin stage-runner in core: reads the formula, invokes engines per
stage (judge / fleet / act-gate / learn), journals each intent+
verdict, transitions per the root table. Resume = last journaled
stage; a verdict-less intent re-checks the world first (see
write-ahead journal).

## Steps (epic children)

1. Pipeline formula schema + validator (`packages/pipeline`): TOML
   shape, typed verdicts, root transitions table, `formulaSha`.
2. Stage-runner core + journal: write-ahead records, transitions,
   resume semantics over registry+dolt.
3. G1 classify stage: judge dedup/group/rank/complexity → labels.
4. G2 route stage: judge → class/kind/orch/timing → `class:` label +
   routing resolution.
5. G3 review stage: `routing.review.chain` config + risk-gated
   internal review on worktree diff.
6. G4 capture stage: self-learn call on land + batched retro hook.
7. Trace stamps: registry fields, commit trailers, PR footer,
   `bro trace` resolver with verify/mismatch verdicts.

## Non-goals

- No Temporal/Mastra/external engine adoption.
- No per-item heavyweight retro session.
- No agent-visible pipeline mechanics.
- proto/molecule formulas unchanged — pipeline is a separate kind.

## Verification

- Prompt audit: no stage/gate/routing vocabulary in worker prompts.
- `bro trace` on a produced PR prints agent, model, session,
  formula@sha, mol step — VERIFIED against registry.
- Kill a runner mid-stage → resume continues at last journaled
  intent; a verdict-less intent re-checks the world, never re-fires
  a side effect blindly.
- cheap-class item skips internal review; complex-class gets one.
