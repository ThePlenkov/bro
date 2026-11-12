# bro-v0pvd.1 — fleet routing: judge-scored complexity+mode → model↔profile matrix → agent selection or queue (shadow slice)

Parent: bro-v0pvd (the fleet epic — "a model like judge decides which
agent handles which task"; judge is a hook-prompt constructor, never
the router). Sibling substrate: specs/fleet-routing/bro-1x7p.md (the
class → provider-chain table this rides beside, not inside) and
specs/sessions/bro-f4ot.2-judge.md (the JudgeFacade contract).

## Problem

Fleet dispatch today routes on ONE dimension: `fleet.routing` maps a
task *class* to an ordered provider chain, and `fleet.router` lets a
judge re-class an unclassed step (shadow|enforce, journaled). Nothing
scores the task's *shape* — how hard it is, what kind of work it is —
and nothing maps that shape onto what each model can actually do. A
dumb free lane and a frontier model sit in the same chain with no
capability declaration between them; the only guard against sending
hard work to a weak model is whoever wrote the chain.

The operator design (bead): BEFORE each spawn, ONE `judge.decide()`
carrying TWO typed questions — `complexity` (score over ordered
levels → probability per level) and `mode` (choice: planning /
coding / review / fix / …) — then DETERMINISTIC code picks the agent
from a hardcoded matrix of models × (modes, complexity ceiling)
declared in `bro.config`. The judge answers questions; the router is
code — the matrix is the hard filter, so a low-complexity-only model
NEVER receives high tasks even when the judge is wrong. Candidate
exists → spawn via fleet profile; no fit → stay queued, re-evaluated
on the next state change; no silent drops. Profiles bind to MODELS
as capability declarations `{modes, complexity}` separate from spawn
mechanics `{provider, model?, backend?}`.

## Slice decision — shadow first

This bead is epic-sized. This PR lands the substrate end-to-end in
**shadow mode**: the config section, the deterministic pick, the
one-call-two-questions judge surface, the journal kind, and the
spawn-path wiring that journals the would-be pick WITHOUT changing
spawn behavior (the same contract `routeClass`/`routePick` already
keep — "v1 is shadow-only: verdicts annotate and journal, they never
act"). Enforcement (the pick actually selecting the profile/provider
lane) and the no-fit → stay-queued consumer are follow-up beads —
the spawn-path provider resolution they must integrate with
(`spawnStepAgent`'s flag→profile→route→backend order,
`lanePicks`/`resolveLoopLane` in the loop) is delicate enough that
landing it unproved beside a brand-new judge call is the risky half
of the epic. What ships now is everything needed to *score* the
router against real traffic before it is allowed to drive it.

## Design

### `fleet.matrix` — the capability matrix (core)

New config section under `fleet`, parsed by `fleetMatrix()` in
`packages/core/src/matrix.ts` (shape-only parse, same convention as
`fleetRouting`/`fleetProfiles` — resolution happens at use time):

```jsonc
"fleet": {
  "matrix": {
    "provider": "orca",              // judge call-surface provider; absent = off
    "mode": "shadow",                // shadow | enforce | off — default shadow
    "complexity": ["low","medium","high"],   // ordered scale, low→high (2–10)
    "modes": ["planning","coding","review","fix"],
    "models": {
      "swe-2-max":  { "modes": ["planning","coding"],
                      "complexity": ["low","medium","high"],
                      "profile": "sweeps" },
      "dirac-auto": { "modes": ["coding"],
                      "complexity": ["low"],
                      "provider": "dirac" }
    }
  }
}
```

- `complexity` — the ORDERED level scale (2–10 unique names). It is
  simultaneously the judge score question's levels and the vocabulary
  each model's `complexity` set names. Default
  `['low','medium','high']`; `modes` defaults to the bead's four.
  A declared scale REPLACES the default — it is the whole vocabulary.
- `models` — the matrix rows, keyed by lane name (the bead's
  `devin/swe-2-max` / `anyrouter/auto` shape — an opaque id, not a
  parsed provider/model pair; dynamic catalog resolution is a
  follow-up). Each row declares capabilities separate from mechanics:
  - `modes` / `complexity` — subsets of the declared vocabularies;
    ABSENT means "every declared mode/level". These are the hard
    filter: eligibility is computed from these declarations in code,
    never from anything the judge says about a model.
  - `profile` — a `fleet.profiles.<name>` preset: the spawn binding
    ("candidate exists → spawn via fleet profile").
  - `provider` — a `providers.<name>` entry: the direct spawn binding
    for lanes that need no preset (the bead's `{agent: dirac}` —
    providers entries ARE the agents). Both bindings optional; a row
    with neither is capability-only (journaled, unspawnable — enforce
    treats it as no-fit).
- Parse fails CLOSED on capability claims: a `modes`/`complexity`
  value naming vocabulary outside the resolved scales drops the whole
  model row with a warning — a typo'd ceiling must never silently
  widen a lane to everything. Scalar fields (`provider`, `mode`,
  `profile`, row `provider`) drop just the field, the fleetProfiles
  convention. `__proto__`/`constructor`/`prototype` row names are
  skipped (same guard as `fleetProfiles`).

### `matrixVerdict()` — the deterministic pick (core)

Pure function over a `DecideResult` + the parsed matrix — no I/O, no
judge types beyond the answer map:

1. `complexity` answer must be a `score` whose qid is NOT in
   `lowConfidence` → level = `clamp(Math.round(score), 0, N-1)` —
   the probability-weighted level rounded to the nearest rung
   (classify.ts' rank precedent; Math.round's .5-up bias fails toward
   the HIGHER level — the safe direction for a hard filter).
2. `mode` answer must be a `choice`, confident, naming a declared
   mode.
3. Either missing/unconfident/malformed → `{kind:'unanswered'}` — a
   dimmed judge produces no verdict, same rule as routeClass.
4. Eligible rows = `modes` absent-or-contains(mode) AND
   `complexity` absent-or-contains(levelName). Pick = FIRST eligible
   row in declared config order — the operator orders cheap lanes
   first and the hard filter does the rest: a low task lands on the
   cheapest sufficient lane, a high task can never reach a
   low-ceiling row because the filter removed it before ordering
   mattered. This is the bead's hard-filter proof, and it is code.
5. No eligible row → `{kind:'no-fit', mode, complexity}` — journaled
   visibly; the follow-up consumer is what parks the task.

### `routeMatrix()` — one decide, two questions (packages/judge)

`packages/judge/src/matrix.ts`, same shape as `router.ts`/`route-pick.ts`:

- `MATRIX_KIND = 'route-matrix'` journal kind (discriminates from
  'route-class'/'route-pick' rows; stats ignores kinds it doesn't
  score — verified: only `answers.action` feeds agreement).
- `matrixQuestions(matrix)` → ONE questions map with exactly two
  entries: `complexity` (`score`, criteria = the ordered scale rendered
  with seed blurbs for the default levels, name-as-description
  fallback) and `mode` (`choice`, criteria = declared modes with seed
  blurbs for planning/coding/review/fix).defineProperty per key —
  `__proto__` safety, same guard as the other question builders.
- `routeMatrix({dir, judge, state, subject, matrix, mode})` →
  `judge.decide(state, questions)` ONCE → `matrixVerdict()` → append
  the `Verdict` row (subject.threadId = the molStep, outcome = picked
  model name | 'no-fit' | 'unanswered') → return the pick only under
  `enforce`; `shadow` returns undefined (the verdict is the whole
  point); `off` never calls the judge. `JudgeUnavailable`
  propagates — the caller owns warn-and-stand, fail-open like every
  judge call.

### Spawn-path wiring — `applyFleetMatrix` (cli)

`packages/cli/src/agent-connectors/core.ts`, beside `applyFleetRouter`:
fires only when `fleet.matrix` is armed — `provider` set, `mode` not
`off`, at least one model row, and the caller's `info` carries
non-empty title/description (nothing to judge otherwise). Binds the
judge exactly like the class router: `requireProviderSurface(…,
'call')` → `providerJudge` → `chainedJudge` with `judge.confidence`/
`timeoutMs`; `enforce` additionally requires a typed-grade surface
(same `requireTypedRouterGrade` contract — prose-grade under enforce
is a config error, never a silent demotion).

Call sites — the same two seams `applyFleetRouter` already rides:

- `spawnStepAgent` (agents.ts): `info` (the `stepClassInfo` bead read)
  is now fetched when EITHER router or matrix is armed — the
  `req.class === undefined` pin still gates only the class router
  (matrix judges the task, not the lane; an explicit `--class` does
  not exempt the bead from complexity/mode scoring). `applyFleetMatrix`
  runs after `applyFleetRouter`, before provider resolution; shadow
  returns nothing so the spawn proceeds untouched.
- `resolveBeadLane` (loop.ts): same insertion, gated on
  `opts.router !== false` so dry-run/render callers (`router:false`)
  never spend a judge call — identical posture to the class router.
  `--class` does not suppress it (orthogonal dimension).

`mode: 'enforce'` is accepted by the schema (forward-compatible) but
`applyFleetMatrix` refuses it with a `SpawnError` naming
`fleet.matrix.mode` — enforcement is the follow-up bead, and a config
that claims enforce while only journaling would be a lie. `off` and
absent-provider matrices are silent no-ops.

## Verify

- `packages/core/src/matrix.test.ts` — parse (defaults, scale
  replacement, fail-closed capability drops, proto-guard) and
  `matrixVerdict` (score→level rounding, confident-gate, hard-filter
  proof: a `complexity:['low']` row is unreachable at level 'high'
  regardless of judge input; declared-order pick; no-fit;
  unanswered).
- `packages/judge/src/matrix.test.ts` — questions shape (exactly
  `complexity`+`mode`, score+choice types, criteria = declared vocab),
  shadow journals `route-matrix` + returns undefined, enforce returns
  the pick, off never calls decide, JudgeUnavailable propagates.
- `packages/core/src/config.test.ts` — `fleet.matrix` section parse
  through `loadConfig`.
- `packages/cli/src/commands/agents.test.ts` — spawn wiring: shadow
  journals beside an unchanged spawn (registry provider/model prove
  behavior identical), enforce → SpawnError, matrix-off → zero judge
  calls, JudgeUnavailable → warn + spawn stands.
- Live smoke — fixture task → scripted systemone reply carrying both
  distributions → journal row shows complexity+mode answers and the
  matrix pick; a high-complexity verdict never resolves to the
  low-ceiling row (hard-filter proof end-to-end); a no-fit verdict
  journals `no-fit` while the spawn proceeds on its static lane
  (queued-visibility is the journal row until the consumer bead).

## Follow-ups (filed as beads)

- **enforce** — `routeMatrix`'s pick → `profile`/`provider` → the
  spawn lane, in both `spawnStepAgent` and `resolveLoopLane`
  precedence; the `enforce` SpawnError lifts.
- **no-fit → queue** — the consumer that parks/re-offs a task whose
  verdict is `no-fit`, visible in loop/backlog, re-evaluated on state
  change (the bead's "stay queued" half).
- **dynamic catalog** — `bro providers models` enumeration feeding
  matrix rows instead of the hardcoded list (bro-0ykhg adjacency).
- **rubric descriptions** — operator-declared per-level/per-mode
  criteria text instead of seed blurbs.
