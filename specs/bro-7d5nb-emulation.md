# Emulation log: bro pipeline (stage-runner)

Spec: `specs/bro-7d5nb.md` — pipeline formulas. The emulated tool is the
not-yet-existing `bro pipeline` stage-runner: it reads a pipeline
formula, journals verdicts, and drives each work item through
classify → route → work → review? → merge → capture. Until it exists
the agent performs the stages by hand, under the formula's contract,
and logs every item here.

Emulated formula under test (the spec's own example):

    classify → route → work → review(gate_on complexity==complex)
             → merge → capture

Per-step bead ids ARE the pipeline items; stage = the item's current
position in the formula. Verdicts are journaled below instead of in
the (future) journal — same data, human-written.

## Run 1: bro-7d5nb.1 — schema + validator (S1)

- Invocation: `bro pipeline run --formula <spec-formula> --item bro-7d5nb.1`
  (as the real runner would be called once it exists)
- Spec reference: formula stages + transition table; "the journal" §;
  "agent-facing artifacts carry no pipeline logic" invariant.
- Input: bead `bro-7d5nb.1` (epic child, needs: [] → ready),
  spec formula, repo `/home/pepl/projects/bro`.
- Expected by spec: classify emits {group, complexity, rank} → route
  emits {class, kind, orch, timing} → work emits an exit-taxonomy
  verdict → review fires iff complexity==complex → merge emits
  landed|blocked|dropped → capture emits captured.
- Actual action and result:
  - classify → `solo` — schema work shares no surface with other
    open items; payload `{group: solo, complexity: complex,
rank: 1}` (epic-first child of bro-7d5nb).
  - route → `spawn` — payload `{class: interactive, kind:
ts-package, orch: foreground, timing: now}` — interactive lane,
    not fleet: capacity stayed with the human session.
  - work → `done` — `packages/pipeline` shipped (parsePipelineFormula,
    formulaSha, loadPipelineFormula, transitionFor), 20 tests,
    [PR #900](https://github.com/ThePlenkov/bro/pull/900).
  - review → `fix` ×N then `push` — the act gate stood in for the
    formula's internal review stage: 22 threads resolved across
    waves (CodeScene findings → real refactor, not suppression;
    module-level advisories → debt bead bro-uucpk). Gate-on fired:
    complexity==complex ⇒ review ran.
  - merge → in flight at log time — auto-merge (SQUASH) armed,
    `act wait --merge --cleanup --bead` watcher; blocked once on the
    required-but-absent `SonarCloud` context (see gaps).
  - capture → pending merge.
- Spec gaps:
  1. **Required-but-absent checks.** `merge` verdict `blocked` is
     spec'd, but the _reason taxonomy_ isn't: act's gate said OK while
     GitHub's ruleset blocked on a required check that never reported.
     Proposed wording: "the merge stage's gate evaluates BOTH reported
     check state and ruleset-required contexts absent from the
     rollup; absent-but-required is `blocked`, not green."
     → filed as `bro-zy871`.
  2. **External-merge cleanup.** When GitHub auto-merge lands instead
     of the watcher, `cleanupAfterMerge` never runs — spec says the
     runner owns post-merge retirement. Proposed wording: "the merge
     stage detects external merges on its next journal tick and runs
     the same cleanup path; `landed` is landed regardless of who
     pushed the button."
  3. **Reviewer waves are not rounds.** The spec's `fix` transition
     loops review→work→review — a work-stage re-entry per wave.
     Reality delivered N independent thread waves, each settled by a
     scoped fix-push on the same worktree, not a fresh spawn.
     Proposed wording: "a `fix` verdict's re-entry into `work` MAY
     be journaled as a wave entry — scoped fix, same worktree —
     rather than a full stage re-run; the transition stays
     `review.fix → work`."
- Friction: the formula's `review` stage conflates "internal review
  model" (spec) with "act gate threads" (reality). Emulating the
  internal reviewer manually is exactly the act-gate loop — the
  spec's risk-gating (complex only) is the part that held: a cheap
  step would have skipped this stage entirely.
- Golden case: **yes** — the spec formula's TOML is already the
  parser's conformance fixture (formula.test.ts "parses the spec
  formula — 6 stages, gate_on, full transitions").

## Standing spec gaps found during Phase-0 spec emulation (fixed in spec)

These were found while emulating the formula on paper before any
code — each became a spec fix and a review-thread resolution on
[PR #899](https://github.com/ThePlenkov/bro/pull/899):

- Cheap items dead-ended (done→review always). → implicit `skip`
  verdict for gated stages + `review.skip = "merge"`.
- Terminal targets were undeclared words. → TERMINAL_ACTIONS
  declared (end|park|retry|close|abandon); reserved as stage names.
- `onWall = "wait"` — invalid under the routing contract. → `park`.
- `rate_limited` had no honest target. → `route` (honors onWall).
- `review.abandon → "close"` conflated drop-settled with drop-failed.
  → `abandon → "abandon"` (one word, one meaning).
- Transitions as multi-line inline tables — invalid TOML. → root
  `[transitions.<stage>]` tables.
- `formula_sha` canonicalization was ambiguous. → sha256 over raw
  bytes, formatting IS identity.
- Trailers presented as authoritative. → driver-attested hints;
  registry lookup is the authority.

## Run 2: bro-7d5nb.2 — stage-runner core + write-ahead journal (S2)

- Invocation: `runPipeline(formula, 'bro-7d5nb.2', opts)` /
  `resumePipeline(formula, 'bro-7d5nb.2', journal)` — the library API
  this item ships (a `bro pipeline run` CLI still does not exist; the
  passage is hand-emulated by the item's own machinery: the fake-
  engine tests replay this same trajectory).
- Spec reference: §write-ahead journal, §terminal actions, §gates and
  the `skip` verdict, §review scoped-fix mode.
- Input: bead `bro-7d5nb.2` (epic child, needs: [.1] → ready),
  spec formula, repo `/home/pepl/projects/bro`.
- Expected by spec: intent journaled BEFORE each side effect; verdict
  completes the record; a verdict-less intent re-checks, never
  re-fires; gate indeterminate fails closed; fix requires notes.
- Actual action and result:
  - classify → `solo` — interpreter work, disjoint from .3–.7's
    stage/engine beads; payload `{group: solo, complexity: complex,
rank: 2}`.
  - route → `spawn` — payload `{class: interactive, kind:
ts-package, orch: foreground, timing: now}`.
  - work → `done` — `journal.ts` (JSONL write-ahead journal under
    `<git-common>/bro/pipeline/`) + `runner.ts` (gate/transition/
    resume engine with injectable `engines` map, `admit` go-marker
    seam, `recheck` hook), 59 package tests green.
  - review → in flight at log time — act gate + CodeScene gate stand
    in for the formula's internal review stage (same standing-in as
    Run 1).
  - merge / capture → pending.
- Design decisions worth recording (spec-consistent, underdetermined
  by the spec):
  - The journal record is one line per `seq`; completing a verdict
    re-appends the SAME seq with verdict+payload — last row per seq
    wins on read. "Intent without verdict" and "completed record" are
    the same shape, which keeps the file's grammar at two verbs
    (append, read) instead of update-in-place.
  - Alert rows carry `resume` — the stage a wake re-enters. Gate-
    indeterminate resumes AT the gated stage; fix-notes-missing
    resumes at the source stage (re-judge); attempts-exhausted
    resumes at the same stage with a fresh attempt series.
  - `recheck` returns EngineResult|'pending'|undefined — 'pending'
    parks WITHOUT a new journal row, so the pending intent stays the
    resume anchor across wakes (an alert row would have overwritten
    the resume point).
  - Spawn-like intents (`intent = 'spawn'` for engine `fleet`) are
    the only ones `admit` gates by default, and the only ones a
    missing `recheck` refuses to re-fire — judge/learn side effects
    are read-shaped, re-firing them is safe; a blind re-spawn is not.
    The seam is mandatory once a spawn-like intent fires: unbound
    `admit` fails closed (`admission-unavailable`), and an `admit`-
    produced refusal verdict journals `admit: true` — its payload is
    refusal detail, never absorbed into the pipeline context.
  - `recheck` distinguishes hook-presence from hook-verdict: NO hook
    fails closed on spawn-like intents, but a hook answering
    undefined attested "didn't land" and re-fires ANY intent under
    the attempt budget — hook presence IS the attestation.
  - `runPipeline` over a non-empty journal IS a resume — one
    `begin()` engine serves both exports; the journal is the state.
  - `formula_sha` drift mid-run fails closed (park + alert) — a
    changed formula is an operator decision.
- Spec gaps hit:
  1. **Recheck verdict source.** The spec says a verdict-less intent
     "re-checks the world" but not WHO answers. A spawn's go-marker
     proves admission, not outcome — the verdict still has to come
     from the engine (exit taxonomy read). Proposed wording: "`admit`
     attests whether the side effect was admitted; `recheck` attests
     the outcome — a landed-but-unverdicted spawn is 'pending', not
     done."
  2. **Park-resume double-read.** Spec says park's resume "re-enters
     at the same stage" — but an ALERT park (gate-indeterminate,
     missing notes) has no verdict to re-enter from; the alert row
     must carry the resume stage itself. The `resume` field on alert
     rows is this run's answer.
- Friction: none beyond Run 1's standing note — the internal-review
  stage is still stood-in by the act gate, so `review.fix` waves
  arrive as act threads, not engine verdicts.
- Golden case: **yes** — the runner tests replay the spec formula's
  full DAG (skip-gate, fix-scope, retry-budget, crash-resume) with
  scripted engines; later stage beads (.3–.6) only supply real
  engines behind the same `EngineMap` seam.

## Run 3: bro-7d5nb.3 — G1 classify stage (S3)

- Invocation: `classifyStage(deps).invoke(call)` inside
  `runPipeline(formula, 'bro-7d5nb.3', opts)` — the stage engine this
  item ships, bound into the runner's `judge` slot via
  `stageDispatch({ classify })` (the runner resolves engines by engine
  name; classify/route/review all share `judge`, so the handler
  multiplexes on `call.stage.name`).
- Spec reference: §typed stage outputs (`{group, complexity, rank}`),
  §stage semantics (dedup/group/rank/complexity; LIFO tie-breaker
  inside a group; output lands as bead labels), invariant 1 (no
  pipeline vocabulary in agent-facing artifacts).
- Input: bead `bro-7d5nb.3` (epic child, needs: [.2] → ready),
  spec formula, peers = the ready ∪ open ∪ in_progress candidate set.
- Expected by spec: judge reads bead + peers → verdict
  solo|clump|duplicate|defer + payload → labels through the task-store
  seam; `complexity` feeds `review.gate_on` verbatim.
- Actual action and result:
  - classify → `clump` — this item shares its surface with .4–.6
    (the other stage-engine beads): same epic, same package, same
    EngineMap seam. Payload `{group: clump, complexity: complex,
clumpId: bro-7d5nb.3, rank: 2}` — the engine is real
    code now; the passage itself is emulated (no `bro pipeline` CLI
    yet): fakes replay it in `stages/classify.test.ts`, including one
    end-to-end `runPipeline` case that drives classify → route → work →
    review and proves `ctx.complexity` is evaluated by `review.gate_on`
    (cheap → the gate synthesizes `skip`; the review engine never
    runs).
  - route → `spawn` — `{class: interactive, kind: ts-package,
orch: foreground, timing: now}`.
  - work → `done` — `stages/classify.ts` + `stages/classify.test.ts`
    - index wiring, 25 stage tests green (108 package total).
  - review → in flight at log time — act gate + CodeScene stand in
    (same standing-in as Runs 1–2).
  - merge / capture → pending.
- Design decisions worth recording (spec-consistent, underdetermined
  by the spec):
  - The judge's contract speaks choice/score/noul only — no free
    text. Every classify datum is therefore a typed question: `dup_of`
    is a `choice` over the peer ids (+`none`), clump-mates are
    per-peer `noul`s, `defer_reason` is a `choice` over declared
    reason codes (a defer payload carries an enum, never prose;
    `unspecified` is a declared code — the fallback when the judge
    affirms defer without naming a reason).
  - The verdict is DERIVED, never asked: no "pick your verdict"
    question exists — `duplicate` = confident dup_of ≠ none,
    `defer` = affirmed defer noul, else the `clump` choice
    (solo/new/existing-id). A single verdict question could disagree
    with its own evidence; deriving can't.
  - Precedence is decisive-first: duplicate (terminal close) >
    defer (park) > clump/solo. A dimmed answer is dropped FOR THAT
    question only — `lowConfidence` marks it unanswered and the
    verdict derives from the rest: a dimmed `clump` reads as solo, a
    dimmed `dup_of` as not-a-dup, a dimmed `defer` as no-defer —
    while a confident sibling still stands (dim `dup_of` + confident
    `clump` ⇒ `clump`). Unanswered `complexity` always reads
    `complex`, so a dimmed judge never sneaks work past review.
  - A `new` clump mints its id from the founding member (`clumpId =
    item.id`) — deterministic, collision-free, self-describing.
    Existing `clump:<id>` labels on peers become joinable choices;
    the judge never invents an id.
  - Labels are REPLACEMENTS on the item (stale `dup:`/`clump:` marks
    removed first — re-classification can't double-tag). Mates are
    re-read through the seam immediately before tagging, so a label
    landing mid-run is honored — a best-effort single-clump guard,
    not a cross-process atomic claim (the store seam has no
    conditional write).
  - `bd` has no `dup` dep type, so `dup:<id>` is a label like
    `clump:<id>` — consistent with the spec's "lands as bead labels".
  - `taskBacklog` peers = ready ∪ open ∪ in_progress — dedup must
    see claimed work (a dup of an in-flight item is still a dup).
  - Judge unavailability and a missing item throw: the pending
    intent is the crash marker; classify's side effects
    (remove-then-add labels) are idempotent under re-fire.
- Spec gaps hit:
  1. **Rank's unit is unspecified.** The spec declares `rank: int`
     and "LIFO tie-breaker inside a group" but not the scale or
     direction. This run maps the judge's 5-level precedence score
     to rank 1..5 (1 = works first). Proposed wording: "rank is a
     small int ordering the item among its peers — lower works
     earlier; equal ranks fall back to LIFO."
  2. **The peer candidate set is unspecified.** "Reads bead + repo
     signals" doesn't say which beads the judge sees. This run feeds
     ready ∪ open ∪ in_progress, weighted-affinity ranked (a shared
     parent weighs most, shared labels next, title-token overlap
     least — additive scores, not strict tiers, so several weak
     signals can outrank one strong one) so the cap cuts the
     least-relevant tail rather than the dedup signal, bounded at the
     decide's criteria limit (8). Proposed wording: "classify's peer
     set is a bounded, affinity-scored candidate list the intake
     plane scopes (ready ∪ open ∪ in_progress); the engine caps what
     one decide carries."
- Friction: the `judge` engine slot is shared by three stages, so a
  formula can't bind classify alone without `stageDispatch` — worth
  noting for .4: the route stage binds the same multiplexer.
- Golden case: **partial** — `stages/classify.test.ts` scripts the
  decide answers; a real-judge replay belongs to the runner-backed
  graduation when items flow under live engines.

## Run 4: bro-7d5nb.4 — G2 route stage (S4)

- Invocation: `routeStage(deps).invoke(call)` inside
  `runPipeline(formula, 'bro-7d5nb.4', opts)` — the stage engine this
  item ships, bound beside classify into the runner's `judge` slot via
  `stageDispatch({ classify, route }, DEFAULT_ADMIT_INTENTS)` (one
  engine slot, multiplexed on `call.stage.name` — the friction noted
  in Run 3 carried forward).
- Spec reference: §typed stage outputs (`{class, kind, orch, timing,
  provider?, model?}`), §stage semantics (`queue` parks until capacity,
  `defer` is an operator verdict, occupancy plane feeds the load
  signal), §transitions (`work.rate_limited → route` honoring
  `fleet.routing.<class>.onWall`), invariant 2 (provider-agnostic
  core — the router emits class/kind, never provider logic).
- Input: bead `bro-7d5nb.4` (epic child, needs: [.3] → ready),
  spec formula, repo `/home/pepl/projects/bro`.
- Expected by spec: judge emits `{class,kind,orch,timing}` →
  `class:` label + routing resolution; `rate_limited` re-entry
  honors onWall — `fallthrough` next chain entry, `park` → queue→park.
- Actual action and result:
  - classify → `clump` — shared surface with .3/.5/.6 (same epic,
    same package, same EngineMap seam); payload `{group: clump,
    complexity: complex, clumpId: bro-7d5nb.3, rank: 3}` (emulated,
    as in Runs 1–3).
  - route → `spawn` — `{class: interactive, kind: ts-package,
    orch: foreground, timing: now}`.
  - work → `done` — `stages/route.ts` + `stages/route.test.ts` +
    index wiring; 30 stage tests green (package suite `pass 55`).
  - review → in flight at log time — act gate + CodeScene stand in
    (same standing-in as Runs 1–3).
  - merge / capture → pending.
- Design decisions worth recording (spec-consistent, underdetermined
  by the spec):
  - The wall re-entry is DETECTED FROM THE JOURNAL, not from ctx or
    a new call field: the last settled route payload followed by a
    settled `rate_limited` on a `spawn` intent — keyed on the intent
    the runner derives (fleet → `spawn`), so a formula that renames
    the work stage still detects the wall, and an `admit` refusal
    verdict counts too (the wall is real even when the spawn never
    fired). A queue-parked route that simply woke shows no death and
    takes the fresh decide path.
  - The wall path is DETERMINISTIC — no decide: `onWall` is the
    class's effective answer (`park` → `queue` reason `onwall`;
    `fallthrough` → next un-walled chain entry, `chain-spent` parks
    when exhausted). The journaled routing fields (class/kind/orch)
    stand; the wall recomputes timing/reason and may replace
    provider/model. Judge cost on a wall: zero.
  - `dispatch` unifies fresh and wall paths: `start` is the chain
    index to try first — 0 fresh, one past the died-on provider on a
    wall. The provider/model PAIR names the slot (a model pin
    belongs to its own provider, matching ResolvedClass docs);
    drift out of the table reads as "head was tried".
  - Saturation is a deterministic guard, not a judge input alone:
    `occupancy` returning `live ≥ cap > 0` parks `queue` reason
    `saturated` even when the judge says `now` — a spawn verdict
    into a full lane lands on the refusal the cap exists to
    pre-empt. The judge's `timing` stays advisory (reason `timing`).
  - `kind` candidates are CALLER-DECLARED (`deps.kinds` — the
    `agents.<kind>` keys in prod); with none declared the question
    is skipped and kind defaults. Orch defaults `exec` — the lane
    with the fewest prerequisites (no session attach, no pane).
  - `queue`/`defer` payloads still carry the resolved provider/model
    when a chain slot resolved — a spent chain parks with none, an
    onwall park keeps the died-on slot it waits out — and, when labels
    are enabled, the `class:` label lands on every verdict. The pin
    records where the item WOULD run, and the wake re-dispatches it.
  - `reason` on queue verdicts discriminates the park input:
    `saturated` (occupancy guard), `timing` (judge said queue),
    `onwall` (class policy parked the wall), `chain-spent`
    (fallthrough exhausted).
- Spec gaps hit:
  1. **`kind`'s domain is undefined.** The spec emits `{class, kind,
     orch, timing}` and says provider packages map class→provider/
     model, but never says what the kind candidates ARE. This run
     treats kinds as caller-declared (`agents.<kind>` keys) offered
     as a `choice`; unanswered → first declared / `default`.
     Proposed wording: "route's `kind` picks among the configured
     agent kinds — the provider package maps the winner to its
     spawn semantics."
  2. **`timing`'s authority is split.** "Judge emits timing" plus
     "queue parks until capacity opens" doesn't say who wins when
     the judge says `now` into a saturated lane. This run makes
     occupancy the deterministic guard (saturation → `queue`
     regardless) and the judge's timing advisory. Proposed wording:
     "the occupancy cap is a hard input: a saturated lane answers
     `queue` even on a judged `now`; the judge's timing can only
     ADD a queue, never remove one."
  3. **Wall detection is journal-derived, not specified.** The spec
     says `rate_limited` "re-enters route honoring onWall" but not
     HOW the stage knows it re-entered on a wall vs a capacity
     wake. This run derives it from the write-ahead journal (last
     route payload + spawn-intent `rate_limited`), which also
     preserves the routing fields the wall path re-uses.
- Friction: the `judge` engine slot is now shared by THREE stages on
  some formulas — `stageDispatch` multiplexes fine, but the wall path
  deliberately never decides, so a judge spy can't distinguish
  "route didn't ask" from "route was skipped" without reading the
  journal. Asserting `judge.calls.length` stays flat is the test's
  answer.
- Golden case: **partial** — `stages/route.test.ts` scripts the
  decide answers and replays the spec formula's `work.rate_limited →
  route` re-entry end-to-end (`pass 55` pipeline tests); a
  live-judge replay stays deferred to the runner-backed graduation.

## Run 5: bro-7d5nb.5 — G3 review stage (S5)

- Invocation: `reviewStage(deps).invoke(call)` inside
  `runPipeline(formula, 'bro-7d5nb.5', opts)` — bound beside
  classify/route into the runner's `judge` slot via
  `stageDispatch({ classify, route, review }, DEFAULT_ADMIT_INTENTS)`
  (the multiplexer Run 3 introduced; the judge slot is now shared by
  all three G-stages).
- Spec reference: §stage semantics review bullet (internal pre-push
  pass via `routing.review.chain`, risk-gated on complexity, `fix`
  re-enters `work` in scoped-fix mode with required `notes`, bounded
  by `pipeline.fixRounds`), §typed stage outputs (`{verdict, notes}`),
  §gates (complex required — cheap synthesizes `skip`), invariant 1
  (no pipeline vocabulary in the decide).
- Input: bead `bro-7d5nb.5` (epic child, needs: [.4] → ready),
  spec formula, repo `/home/pepl/projects/bro`; the reviewed artifact
  = this item's own diff on `work/bro-7d5nb.5`.
- Expected by spec: `routing.review.chain` resolves a review-capable
  provider; judge reads the worktree diff → `push` → merge / `fix`
  (with `notes`) → scoped work re-entry / `abandon` → terminal; cheap
  items never reach the engine.
- Actual action and result:
  - classify → `clump` — same stage-engine surface as .3/.4/.6;
    payload `{group: clump, complexity: complex, clumpId:
    bro-7d5nb.3, rank: 3}` (emulated, gate field set so review
    fires).
  - route → `spawn` — `{class: interactive, kind: ts-package,
    orch: foreground, timing: now}`.
  - work → `done` — `stages/review.ts` + `stages/review.test.ts`
    - index wiring; 28 stage tests green (package suite `pass 167`).
  - review → in flight at log time — act gate + reviewers stand
    in (same standing-in as Runs 1–4); the stage under test emits
    `push`/`fix`/`abandon` under scripted decides.
  - merge / capture → pending.
- Design decisions worth recording (spec-consistent, underdetermined
  by the spec):
  - `routing.review` is a routing class NAMED `review` in the same
    `fleet.routing` table the route lanes use — `routing.review.chain`
    reads literally as `fleet.routing.review.chain`. Entries validate
    against the `call` surface, NOT `spawn`: reviewing is judging, so
    an `api` provider that could never spawn a worker still reviews —
    `resolveStepClass` was not reusable (it asserts `spawn`).
  - The reviewer slot is the first un-walled chain entry — walls fall
    through like the route dispatch, and an all-walled chain THROWS
    (the pending intent is the crash marker; the bounded re-fire waits
    the wall out) rather than attributing a verdict to a provider that
    can't answer. The slot stamps `reviewer: {provider, model?}` on
    the payload — NESTED, because flat `provider`/`model` keys would
    clobber route's own spawn slot in the merged context and flip
    their meaning mid-pipeline (traceability for "via
    `routing.review.chain`").
  - The verdict is DERIVED, never asked (same contract as classify):
    `abandon` = affirmed abandon noul; `fix` = ≥1 affirmed
    `finding_<kind>` noul; `push` = affirmed push noul; precedence
    abandon > findings > push. Push is NEVER the default — a judge
    that withholds the push affirmation while categorizing nothing
    takes one bounded fix round (`UNCATEGORIZED_FIX_NOTES`), because
    unaffirmed-to-push work must not sail to merge on a dimmed or
    denied read. A decide with ZERO confident gating answers throws —
    the diff was never read, and manufacturing a verdict from nothing
    is worse than a crash marker + bounded re-fire.
  - `notes` is COMPOSED, never judge-written: the decide contract
    speaks choice/score/noul only, so `fix` notes join the affirmed
    finding kinds' rubric lines (`correctness: …; tests: …`) into the
    scope text the work re-entry reads — non-empty by construction,
    which is exactly the runner's `notesFor` contract.
  - The diff reaches the judge through an injected `diff` SEAM taking
    the `StageCall` (ctx.work provenance + journal in, `{diff, files?,
    worktree?, base?, head?}` out) — the stage never invokes git;
    prod wires `git diff` over the journaled work payload behind it.
    `undefined` = no reviewable artifact → throw; `''` = a `done` that
    changed nothing — a reviewable fact the judge sees. The decide
    state carries a bounded window (`maxDiffChars`, default 24k, +
    `truncated` flag) and a bounded file list (40 names + count).
    `maxDiffChars` is validated (non-negative integer — NaN would
    silently unbound the window), and an affirmed `push` on a
    truncated read DEMOTES to `fix` with a convergent note — "narrow
    the change below the window (split or shrink the diff) so the
    whole diff is judged": the tail was never judged, so unreviewed
    content does not merge on a prefix read; a diff that cannot
    converge burns `fixRounds` and parks, which is the honest
    park-condition for an unreviewable change.
  - The scoped-fix history comes from the JOURNAL, not ctx: highest
    `fix_round` + its `notes` ride the decide state as `fix:
    {round, notes}` so a re-review sees what the last round was asked
    to mend — same journal-authority split as route's wall evidence.
    A prior review's `notes` flat-merged into ctx is deliberately NOT
    read (stale scope; the runner already keys on this verdict's
    payload).
- Spec gaps hit:
  1. **How the diff reaches the judge is unspecified.** "Internal
     review pass on the worktree diff" doesn't say whether the stage
     reads git, the work payload, or a seam. This run takes the
     minimal faithful seam: `diff(call) → ReviewDiff | undefined`
     (provenance fields `worktree`/`base`/`head`/`files` + text),
     prod wires `git diff` against the journaled work record. Proposed
     wording: "the review engine's diff input is a seam — it reads the
     work stage's journaled worktree provenance and returns the
     bounded diff text + file list; the stage never invokes git
     itself."
  2. **`notes` has no producer.** The spec types review's payload as
     `{verdict, notes}` but the judge contract can't emit free text.
     This run declares a finding-kind enum (`correctness|scope|tests|
     safety|quality`, one noul each) and composes notes from the
     affirmed kinds' rubric lines — the enum IS the scope vocabulary.
     Proposed wording: "review's `notes` is composed by the stage from
     the affirmed finding categories — the judge's typed answers name
     the kinds, the stage's rubric text carries the actionable
     scope."
  3. **The chain's authority is designation, not dispatch.** The
     spec's "via `routing.review.chain`" doesn't say whether the chain
     selects the deciding backend — the bound JudgeFacade decides
     regardless. This run records BOTH: `reviewer` = the designated
     (first un-walled) chain slot, and `judge = {model, decidedBy?}`
     = the decide's own attribution (`res.model` plus the connector
     when every answer names one) — the backend that DID answer, not
     just the one that may. Proposed wording: "the review chain names
     the providers a verdict may be attributed to; the payload stamps
     the designated slot AND the decide's own model/connector."
- Friction: same shared-`judge`-slot caveat as Runs 3–4, plus the
  zero-signal throw needed a test to distinguish "judge alive but
  dimmed" (≥1 confident answer → derive fix) from "judge answered
  nothing readable" (zero confident → throw) — the spy's answers map
  only holds asked answers, so scripting "everyone denied" matters.
- Golden case: **partial** — `stages/review.test.ts` scripts the
  decide answers and replays the spec formula end-to-end: complex →
  review push → merge; cheap → gate `skip` with the engine never
  invoked; fix → work re-entry carrying `notes`+`fixRound` →
  re-review push; abandon → terminal; `fixRounds` exhaustion → park
  (`pass 167` pipeline tests). A live-judge replay stays deferred to
  the runner-backed graduation.

## Run 6: bro-7d5nb.6 — G4 capture stage (S6)

- Invocation: `captureStage(deps).invoke(call)` inside
  `runPipeline(formula, 'bro-7d5nb.6', opts)` — the stage engine this
  item ships, bound into the runner's `learn` slot (a slot the three
  judge stages never touch — no multiplexer needed: `learn` is
  capture's engine alone in the spec formula).
- Spec reference: §stage semantics capture bullet ("`self learn
  capture` on land (cheap, per-item); heavyweight session retro runs
  batched off-path"), §typed stage outputs (`{lessons: int,
  followups: [beadId]}`), §transitions (`merge.landed → capture`,
  `capture.captured → end`), the formula's
  `mode = "always-capture"` stage token, non-goal "no per-item
  heavyweight retro session".
- Input: bead `bro-7d5nb.6` (epic child, needs: [.5] → ready),
  spec formula, repo `/home/pepl/projects/bro`.
- Expected by spec: on `merge.landed` the learn engine distills the
  item's artifacts into trigger-gated lessons (cheap: the seam's
  dedup makes a re-sweep merge-only); the batch retro hook records
  the intent, never executes it per-item; verdict `captured` → end
  with `{lessons, followups}` absorbed into ctx.
- Actual action and result:
  - classify → `clump` — same stage-engine surface as .3–.5;
    payload `{group: clump, complexity: complex, clumpId:
    bro-7d5nb.3, rank: 4}` (emulated, as in Runs 1–5).
  - route → `spawn` — `{class: interactive, kind: ts-package,
    orch: foreground, timing: now}`.
  - work → `done` — `stages/capture.ts` + `stages/capture.test.ts`
    - index wiring; 27 stage tests green (package suite `pass 197`
      across all seven test files).
  - review → in flight at log time — act gate + reviewers stand
    in (same standing-in as Runs 1–5); the stage under test emits
    `captured` under scripted seams.
  - merge → pending; capture → the engine under test.
- Design decisions worth recording (spec-consistent, underdetermined
  by the spec):
  - Two injected seams, both taking `(call, LandContext)`:
    `capture` is the learn-capture path (prod binds
    `captureLessons` only via a future adapter that maps its
    `CaptureReport` into `CaptureOutcome` — the stage calls the
    seam, never the CLI and never `@broject/learn` directly;
    pipeline keeps its one-dep shape), `retro` is the
    batched-retro intent QUEUE — a required
    dep, because an unwired hook is a wiring error, not a skipped
    retro. The queue records that this item's run joins the next
    off-path retro batch; `void` or `{batch}` back, and the payload
    marks `retro: {queued: true, batch?}` — the journaled captured
    record IS the durable proof the hook fired.
  - Land context comes from the JOURNAL (same authority split as
    route's wall evidence / review's fix history): the stage scans
    this run's settled records — a settled `landed` verdict MUST
    exist (the merge stage's spec enum word; a formula may name the
    stage differently, the verdict is fixed). Capture reached with
    no land throws — a capture of un-landed work would teach
    lessons that never survived a merge gate, so the pending intent
    is the crash marker and the bounded re-fire parks the item
    (`attempts-exhausted`) instead of harvesting nothing into
    lessons. `mol` is the LAST settled payload carrying a string
    `mol` field (convoy's `{mol: <id>}` convention — a scoped-fix
    work re-entry can re-pour; freshest wins; a non-string `mol` is
    malformed payload data, skipped for the next record).
  - `mode` is validated: absent reads `always-capture`, an unknown
    token throws — a stage that can't tell its capture scope can't
    know what it runs (same fail-loud posture as an empty routing
    table or a missing `routing.review`).
  - The seam's outcome is validated before it becomes the payload:
    `lessons` must be a non-negative int, `followups` a bead-id
    list, `skipped` `{origin, reason}` records, the retro receipt
    `{batch?}` or void. Malformed → throw: the sweep DID run (its
    dedup makes re-fire merge-only) but an unreadable report can't
    be echoed into the pipeline context.
  - Sweep BEFORE queue: the retro intent describes a completed
    capture. A throwing retro propagates with the sweep already
    done — re-fire re-runs a dedup-safe capture.
  - No `recheck` hook: `learn` is not a spawn-like intent, so a
    verdict-less capture re-fires inside the attempt budget like
    the judge stages' — the seams' side effects are idempotent
    (lesson dedup folds a re-sweep into a merge; a batch queue
    dedups on the item/run key it must already take).
- Spec gaps hit:
  1. **The batched-retro mechanism is unspecified.** The spec says
     "heavyweight session retro runs batched off-path" but names no
     seam — no queue, marker, or schedule exists in the repo to
     bind. This run takes the minimal faithful seam: an injected
     `retro(call, ctx) → {batch?} | void` the stage calls once its
     sweep completes — a throwing capture aborts before queueing,
     so the intent always describes a finished capture; prod wires
     whatever batch carrier emerges (a
     bead, a file, a schedule). Proposed wording: "the capture
     engine's retro hook is a queue seam — it records the item's
     membership in the next retro batch and returns the batch id;
     execution is the batch runner's, never the stage's."
  2. **What the harvest scopes to is unspecified.** "The item's
     artifacts" doesn't say how capture learns WHICH artifacts this
     run produced. This run derives it from the journal: the item
     id + the last journaled `mol` + the land record's provenance
     (a `pr:` ref in the merge payload is lesson evidence
     material); the store-wide dedup sweep does the rest.
  3. **`landed` has no producer guarantee.** `merge.landed →
     capture` is the only path in the spec formula, but nothing
     stops a formula from reaching capture another way. This run
     treats a missing settled `landed` as malformed invocation —
     fail closed to park, same as every other broken-context
     branch (gate-indeterminate, fix-notes-missing).
- Friction: `resumePipeline` derives run identity from the
  journal's own `runId` — a `memoryJournal()` created without one
  mints a fresh id per resume, silently orphaning the pending
  intent (the resume became a fresh run and re-threw instead of
  exhausting attempts). Worth a doc note on `memoryJournal` or an
  opts.runId requirement in tests driving resume.
- Golden case: **partial** — `stages/capture.test.ts` scripts both
  seams and replays land→capture→end inside `runPipeline` (two
  mini-formulas: merge→capture needing NO `admit` seam, and an
  `ok`-merge formula proving the fail-closed park); the spec DAG
  case drives cheap-complexity → gate skip → merge → capture with
  the work payload's `mol` reaching the sweep (`pass 197` pipeline
  tests). A real `captureLessons` binding stays deferred to the
  runner-backed graduation.

## Graduation

- Stage: **runner-backed, library-only** — `.2` delivers the
  stage-runner + write-ahead journal: intents journal before every
  side effect, verdicts complete the same seq, gates evaluate against
  replayed context, resume re-checks pending intents, then settles,
  parks, or boundedly re-fires on a "didn't land" attestation. The
  item's own pass through the pipeline is still
  hand-emulated (a `bro pipeline` CLI doesn't exist yet); merge is in
  flight and capture remains pending at log time.
- Scripted: yes at the library level — the fake-engine suite replays
  the spec formula's full DAG as a golden test. Worth promoting to an
  operator-facing runner when ≥2 items run concurrently under real
  engines.
- Real: `.3–.6` bind real engines (classify/route/work/review/
  merge/capture) behind the `EngineMap` + `admit`/`recheck` seams;
  `.7` stamps traceability — after that, logged runs replay as
  golden tests end to end.
