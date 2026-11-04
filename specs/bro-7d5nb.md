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
[[stages]]
name = "review"            # G3: internal review — risk-gated
engine = "judge"
gate_on = "complexity == complex"   # cheap-class items skip
verdicts = ["push", "fix", "abandon"]
[[stages]]
name = "capture"           # G4: self-learn + plan next tasks
engine = "learn"
mode = "always-capture"    # per-item cheap; batch retro is separate
transitions = { solo = "route", clump = "route", duplicate = "close",
  defer = "park", spawn = "work", queue = "park", fix = "work",
  abandon = "close", done = "capture" }
```

### Stage semantics

- **classify** — judge reads bead + repo signals; emits group/dedup/
  rank. LIFO remains tie-breaker INSIDE a group. Output lands as bead
  labels/claims, never in the prompt.
- **route** — judge emits `{class, provider_kind, model_hint,
  orchestrator: acp|foreground|exec, now|queue}`; occupancy plane
  (`fleetOccupancyFor`) feeds the load signal. The verdict resolves
  through `fleet.routing.<class>.chain` — core never names a provider.
- **work** — spawn via facade → registry pins {pid, prompt, exit};
  `resolveWorktree` reuses recorded checkouts (resume semantics).
- **review** — internal pre-push pass via `routing.review.chain`
  (review-capable providers list). Risk-gated on classify's
  complexity verdict: `complex` required, `cheap` skips to merge gate.
- **capture** — `self learn capture` on land (cheap, per-item);
  heavyweight session retro runs batched off-path.

### Traceability

Stamps written BY THE DRIVER (agent cannot forge its own provenance):

- spawn → registry entry: `formula`, `formula_sha`, `session_id`,
  `pipeline_stage` (extends existing provider/backend/sessionKind)
- commit → trailers: `BRO-Run: <agentId>`, `BRO-Formula: <id>@<sha>`,
  `BRO-Session: <id>`
- PR → body footer: run/formula/session line
- `bro trace <commit|pr|branch>` — resolves the chain backwards
  (branch→worktree→registry→agent→provider/model→formula@sha→mol step)

### Interpreter

A thin stage-runner in core: reads the formula, invokes engines per
stage (judge / fleet / learn), journals each verdict, transitions per
the table. Resume = last journaled stage, not replay. Crash → the
registry's `.exit` taxonomy classifies the in-flight worker; the
runner resumes at the verdict it never wrote.

## Steps (epic children)

1. Pipeline formula schema + validator (`packages/convoy` or new
   `packages/pipeline`): TOML shape, verdict types, transition table,
   content hash.
2. Stage-runner core + journal: verdict records, transitions, resume
   semantics over registry+dolt.
3. G1 classify stage: judge dedup/group/rank → bead labels.
4. G2 route stage: judge → class/kind/orchestrator/now-queue →
   `class:` label + routing resolution.
5. G3 review stage: `routing.review.chain` config + risk-gated
   internal review on worktree diff.
6. G4 capture stage: self-learn call on land + batched retro hook.
7. Trace stamps: registry fields, commit trailers, PR footer,
   `bro trace` resolver.

## Non-goals

- No Temporal/Mastra/external engine adoption.
- No per-item heavyweight retro session.
- No agent-visible pipeline mechanics.
- proto/molecule formulas unchanged — pipeline is a separate kind.

## Verification

- Prompt audit: no stage/gate/routing vocabulary in worker prompts.
- `bro trace` on a produced PR prints agent, model, session,
  formula@sha, mol step.
- Kill a runner mid-stage → resume continues at last journaled stage.
- cheap-class item skips internal review; complex-class gets one.
