# bro-v0pvd.2 — pipeline: act-gate (merge) stage engine — PR settle probe → landed|blocked|dropped + pending-intent suspend

Parent: specs/bro-7d5nb.md (pipeline formulas §merge — `engine =
"act-gate"`, verdicts `landed|blocked|dropped`, transitions
`landed → capture`, `blocked → retry`, `dropped → close`). Sibling
boundary: bro-qjji2.12 owns the fleet `work` engine (the payload this
stage reads `pr`/`worktree` from — PR #999 in flight, not merged);
bro-qjji2.10 owns the production run-starter + prod engine map this
factory joins; bro-v0pvd.3 owns the run waker that re-drives parked
runs — this bead ships ONLY the `act-gate` slot's factory. The gap:
`STAGE_ENGINES` and `STAGE_INTENTS` already know `act-gate` → intent
`gate`, but no production `EngineHandler` exists — every formula
reaching `merge` parks `engine-unavailable` (all tests bind spies).

## Design

`actGateStage(deps)` in `packages/pipeline/src/stages/act-gate.ts` —
an `EngineHandler` for the runner's `act-gate` slot, same factory
shape as accept/verify/capture. The engine owns PR-identity
resolution, the lifecycle→verdict mapping, and the gate payload;
everything host-facing stays behind ONE injected seam.

### The probe seam — the stage never calls gh/git

```ts
interface ActGateDeps {
  /** the act-state read — prod binds fetchPrActState +
   *  evaluateExitGate + gatePending behind it (the @broject/act
   *  settle semantics stay in the act package; the stage maps the
   *  normalized observation onto the formula enum). MUST be
   *  read-only and idempotent: invoke and recheck call it on every
   *  wake with no dedup channel. Returns undefined ONLY for a
   *  definitive "no PR at this ref"; transient/read failures THROW
   *  (the pending intent is the crash marker, the bounded re-fire
   *  is the retry). */
  probe(call: StageCall, pr: ActGatePrRef): MaybePromise<ActGateObservation | undefined>;
}
```

`ActGateObservation` is the normalized settle read:

- `state` — the PR lifecycle, host-normalized `'OPEN' | 'MERGED' |
  'CLOSED'` (the `PrMeta` vocabulary). Anything else is a malformed
  seam answer → throw.
- `headSha?`, `url?`, `mergedBy?` — provenance strings.
- `gate?` — REQUIRED when `state === 'OPEN'`: `{ok, settling,
  blockers?, ciPending?, reviewersPending?, ciFailing?,
  openThreads?}` — `ok` is the evaluated gate verdict, `settling`
  the still-in-flight read (pending CI/reviewers/mergeability —
  `gatePending`'s answer), `blockers` the named settled reasons.
- `provider?`, `model?` — which backend/connector answered the
  probe; journaled NESTED inside the payload's `gate` slot, never
  flat (route's payload owns the flat `provider`/`model`/`class`
  keys — review's `reviewer` slot set the precedent).

### Lifecycle → verdict — the settle state, mapped once

| observation                     | outcome |
| ------------------------------- | ------- |
| `state === 'MERGED'`            | `landed` — it landed, gate irrelevant (evaluateExitGate reads non-OPEN as ok) |
| `state === 'CLOSED'`            | `dropped` — closed unmerged, terminal (`→ close`) |
| `OPEN` + `gate.settling`        | `'pending'` — still settling; the intent stays the resume anchor |
| `OPEN` + `!settling` + `ok`     | `landed` — the act gate settled green |
| `OPEN` + `!settling` + `!ok`    | `blocked` — settled with blockers (`→ retry`, bounded by `pipeline.maxAttempts`, exhaustion parks) |

`settling` is checked FIRST: a PR with a settled blocker AND a
pending check is still settling — `pending` waits for free on the
next wake instead of burning the retry budget on a gate that has
not finished computing (`gatePending` semantics verbatim).

A malformed observation — non-record, unknown `state`, `OPEN`
without a well-formed `gate` (`ok`/`settling` non-boolean,
`blockers` not a string list, counts not numbers) — THROWS: the
seam's contract broke, the pending intent is the crash marker, and
the bounded re-fire/recheck waits for a well-formed read (same
fail-loud posture as verify's evidence rows and work's `checkItem`).

### PR identity — from pipeline ctx, fail closed when absent

The merge gate probes the PR the run's work produced. Payloads merge
flat AND under their stage name, so the candidates are read in
contract order — flat keys first (the merged view `gate_on` also
reads; freshest wins), the `work` stage's own scoped record as the
defensive fallback (bro-qjji2.12's payload may carry `pr`/`worktree`
under `work`; `draft_pr` is the accept bundle's established alias —
"the review surface a work stage already opened"):

`ctx.pr` → `ctx.draft_pr` → `ctx.work.pr` → `ctx.work.draft_pr`

First DEFINED candidate wins, then shape-validates: a positive
integer, a non-empty string, or a non-empty record is a usable ref
(the probe owns host-vocabulary interpretation — `42`, `'pr://77'`,
`{repo, number}`, a URL are all the seam's problem, not the stage's).
Anything else — absent, `true`, `0`, `''`, `{}`, an array — parks
with `PARK_ALERTS.prIdentityMissing` + detail: the gate cannot probe
what it cannot name, and a malformed identity is never probed (the
same fail-closed contract as accept's missing `run.customer` — a
corrected context on a later wake can still settle; the alert row is
a repairable park, not a tombstone).

`probe` answering `undefined` — definitive "no PR at this ref" —
parks `PARK_ALERTS.prUnreadable`: the gate cannot settle on a PR that
isn't there; the world must repair (wrong ref, recreated PR) before a
wake helps. Two new `PARK_ALERTS` tags, both engine-reported
`EngineAlert`s — the run never moves on them.

### Suspension — 'pending' leaves the intent as resume anchor

`invoke` and `recheck` share ONE `settle()` — the probe is a
read-only observation with no side effect to attest, so both paths
answer identically: `'pending'` parks WITHOUT a verdict row (the
verdict-less `gate` intent stays the resume anchor a later wake's
`recheck` re-probes), a settled observation completes the record.
No dedup channel is needed — unlike accept's `emit`, nothing was
fired that could double. `recheck` never returns `undefined`: there
is no "did the side effect land" question — the intent IS the read,
and the probe always answers the CURRENT state. A `gate` intent is
not in `DEFAULT_ADMIT_INTENTS` (`['spawn']`), so no go-marker is
consulted and a verdict-less one re-fires only through `recheck`,
never blind.

### The payload — spec §typed stage outputs + provenance

`ActGatePayload` merges into ctx flat AND under the stage name:

```ts
{ verdict, pr, headSha?, url?, mergedBy?,
  gate?: { ok, settling, blockers?, ciPending?, reviewersPending?,
           ciFailing?, openThreads?, provider?, model? },
  summary? }
```

`pr` echoes the resolved ref verbatim — capture's land scan already
reads the `landed` record's payload as lesson evidence ("a `pr:` ref
is lesson evidence material"). `gate` carries the settle read +
probe provenance nested — flat `provider`/`model` would overwrite
route's in the merged context. `summary` is a deterministic line off
the observation, never seam text.

## Non-goals

- The production binding — bro-qjji2.10's run-starter owns the engine
  map (`probe` over `fetchPrActState`/`evaluateExitGate`/`gatePending`
  + the `ReviewFacade`, PR-target resolution from ctx/worktree). This
  bead ships the factory + contract only.
- The work stage's `pr`/`worktree` payload fields — bro-qjji2.12's
  engine may add them; act-gate consumes whatever ctx carries and
  fails closed when nothing usable lands.
- Resume/wake machinery — bro-v0pvd.3 owns the run waker; `pending`
  + `recheck` is the whole async contract here.
- Merging — the stage PROBES settle state; landing the PR is the
  host's auto-merge/act machinery, outside the formula.

## Verification

- `packages/pipeline/src/stages/act-gate.test.ts` — hermetic: scripted
  `probe` fakes → the lifecycle matrix (MERGED/CLOSED/OPEN×
  settling×ok), pending-suspend on invoke AND recheck (idempotent —
  probe re-asked, no dedup), ctx identity resolution (`pr`,
  `draft_pr`, `work.*` fallback, malformed/absent → park+alert),
  probe-undefined → park+alert, malformed observations → throw,
  payload shape (nested gate provenance, `pr` echo), and
  `runPipeline` slices: pending→wake→landed, blocked→retry-budget→
  park, dropped→close.
- `npm run build`, `npm run typecheck`, `npm test` (pipeline package),
  biome on touched files.
