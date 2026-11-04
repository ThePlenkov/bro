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
     spec'd, but the *reason taxonomy* isn't: act's gate said OK while
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

## Graduation

- Stage: **manual** — stages through merge were executed by hand
  under the formula's contract; merge is in flight and capture
  remains pending at log time.
- Scripted: not yet — worth it when ≥2 items run concurrently.
- Real: `.1` delivers the schema half of the runner; `.2` delivers
  runner+journal — after that, logged runs replay as golden tests.
