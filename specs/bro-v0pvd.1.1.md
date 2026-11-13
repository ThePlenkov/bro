# bro-v0pvd.1.1 — fleet.matrix enforce — pick→lane resolution + no-fit stays queued

Parent: specs/bro-v0pvd.1.md (the shadow slice — `fleet.matrix`
config, one `decide()` carrying complexity+mode, deterministic
`matrixVerdict`, `route-matrix` journal rows, `applyFleetMatrix` on
both spawn seams). Epic: bro-v0pvd.1 ("no fit → stay queued,
re-evaluate on next state change" — the half the shadow slice
deliberately deferred). Bead: bro-v0pvd.1.1.

## Gap

The shadow slice journals the would-be pick and nothing else:

- `mode: "enforce"` is REFUSED in `applyFleetMatrix`
  (`agent-connectors/core.ts`) before any judge call — a config
  claiming enforce while only journaling would lie.
- The pick never reaches the lane: `spawnStepAgent` /
  `resolveBeadLane` keep the static provider/profile resolution
  authoritative.
- `no-fit` journals visibly but the task still spawns on its static
  lane — the "stay queued, re-evaluate on next state change"
  consumer does not exist.

## Design

### Verdict contract — `routeMatrix` returns the whole verdict under enforce

`packages/judge/src/matrix.ts`: under `enforce`, `routeMatrix` now
returns the full `MatrixVerdict` — `pick`, `no-fit`, or
`unanswered` — instead of pick-or-undefined. The caller must
distinguish "routed" from "held"; collapsing no-fit/unanswered to
undefined would force every consumer to re-derive the verdict from
the journal. `shadow` still returns undefined (the journal row IS
the point), `off` still never calls the judge, and the verdict
always journals under every mode exactly as before.

### `applyFleetMatrix` — returns the verdict, gates enforce honestly

`packages/cli/src/agent-connectors/core.ts`:

- Return type `Promise<MatrixVerdict | undefined>` — the
  `routeMatrix` result under enforce, `undefined` everywhere the
  matrix is off/unarmed/judge-down (shadow included: shadow's
  `routeMatrix` returns undefined, so the spawn proceeds untouched —
  behavior identical to the shadow slice).
- The loud `enforce`-refusal SpawnError is REMOVED — enforce is real
  now.
- Enforce additionally requires a typed call surface: the same
  `requireTypedRouterGrade` contract the class router keeps,
  parameterized on the config key (`fleet.matrix.provider`) so the
  error names provider + mode. A prose-grade entry under enforce is
  a config error, never a silent demotion; shadow still accepts
  prose.
- Blank task text (no title/description to judge) under enforce
  returns a synthesized `{kind:'unanswered'}` — no decide call, no
  journal row (there is nothing to score), and the caller's hold
  path treats it exactly like a judge-produced unanswered verdict.
  Under shadow it returns undefined as before.
- `JudgeUnavailable` still propagates to the warn-and-stand catch:
  judge OUTAGE fails open to the static lane (the standing judge
  contract — infra failure is not a verdict). The warning now names
  the static lane explicitly so an enforce run's fail-open is never
  silent about having bypassed the router.

### `matrixLanePick` + `MatrixHoldError` — verdict → lane fields or hold

One resolver both spawn seams share, in `agent-connectors/core.ts`:

- `verdict === undefined` → `undefined` (shadow/off/judge-down —
  proceed on the static lane).
- `kind !== 'pick'` → throw `MatrixHoldError` — a `SpawnError` of
  kind `'cap'` (503 on serve, `die` message on `agents up`) whose
  message carries the verdict: no-fit names mode+complexity, hold
  names the unanswered policy. Being a SpawnError subclass keeps
  every existing refusal surface honest; being its own class lets
  the loop distinguish "the matrix held this task" from "routing
  broke".
- `kind === 'pick'` → resolve the row's spawn bindings into lane
  fields `{lane, provider, model?, autoApprove?}`:
  - `profile` binding wins over `provider` when both are declared
    (the preset is the richer binding — it can carry model +
    autoApprove); `provider` is the direct `providers.<name>`
    binding for preset-less lanes. A row declaring NEITHER is
    capability-only — journaled under shadow, unspawnable under
    enforce → `MatrixHoldError` (the shadow spec already ruled
    "enforce treats it as no-fit").
  - The profile resolves through `fleetProfileOf`; a missing preset
    is a config error naming `fleet.matrix.models.<lane>.profile`
    (kind `'config'`) — lazy resolution at the picked row only, a
    bad row never blocks spawns it wasn't picked for.
  - `model` is `profileModelFor(profile, provider)` — a profile's
    model rides only on its own provider's lane, the same rule
    `--profile` keeps; a `provider`-direct row contributes no model
    (the entry's own pin applies inside `resolveSpawnProvider`).
  - `profile.backend` is NOT honored — connector resolution precedes
    routing on every spawn path; the matrix binds provider/model/
    policy, never the backend. Documented limitation.
- `lane` is the picked row's name — provenance.

### Precedence — explicit picks > matrix > class route > static lane

The pick joins provider resolution as a new tier on BOTH seams,
just below explicit operator picks and above the class-route chain
head and every static fallback:

- `spawnStepAgent`: `provider = req.provider ?? profile?.provider ??
  matrixPick.provider ?? route?.provider`; model inserts
  `provider === matrixPick.provider ? matrixPick.model` between the
  flag-profile model and the routed model (same provider-gated rule
  as `route.model`); `autoApprove = req.autoApprove ??
  profile?.autoApprove ?? matrixPick.autoApprove` (ungated, the
  `--profile` convention). `--provider`/`--model`/`--auto-approve`/
  `--profile`/`--agent`/template `--agent` all still outrank the
  pick piecewise — an explicit per-spawn request is never
  second-guessed by the router. `--class` does not suppress the
  matrix (it judges the task, not the lane — the shadow contract).
- `resolveLoopLane`/`lanePicks`: same insertion —
  `sel.provider ?? --agent-provider ?? flagProfile?.provider ??
  matrixPick.provider ?? route?.provider ?? cfgProfile?.provider ??
  cfg.provider`; model/autoApprove mirror the same order. The
  matrix outranks `route?.provider` deliberately: under enforce the
  capability pick is the task-shape authority; the class chain is
  the generic router. Config picks (`loop.provider`,
  `loop.profile`, `agents.<backend>.provider`, template) ARE the
  static lane the pick overrides.
- `routeSpec` (the class chain's wall-walk candidates) is
  suppressed whenever a matrix pick is engaged on either seam —
  walking to a chain candidate would spawn a lane the capability
  filter never vetted. `lane.class`/`spec.class` provenance still
  stamps: class routing and matrix routing are orthogonal
  dimensions.

### Provenance — `matrix` rides like `class`

The picked row's name stamps the full `class` mirror:
`SpawnSpec.matrix` → `BRO_AGENT_MATRIX` env pin (AGENT_PIN_KEYS —
connector-owned, unforgeable), registry `matrix` field,
`AgentInfo.matrix`, and lifecycle spawn detail;
`LoopLane.matrix` → `provenancePins`, the template arm's env merge,
and `spawnWorker`'s spec. The `route-matrix` journal row remains
the decision record (subject = molStep, outcome = lane name |
no-fit | unanswered).

### The no-fit consumer — defer, re-judge on wake

`pushItem`'s `resolveBeadLane` catch gains a `MatrixHoldError`
branch BEFORE the generic route-failure park: `parkBeads(ctx,
clump, <verdict reason>)` — every still-open clump member defers
with `parkedWakeMin`'s cooldown and its assignee cleared, the note
names the verdict (mode/complexity for no-fit, the unanswered
policy otherwise), and the run record ends (the claims are
released — custody dies with them). Deferred rows hide from
`ready`; the lazy wake undefer's them to open past the horizon —
the next claim re-judges against whatever state changed (matrix
config, judge calibration, bead text). `bd undefer` releases one
early — the manual "state change" trigger. This is the bead's
"stay queued, re-evaluate on next state change": bounded
re-evaluation, never a hot judge-call loop, never a silent
static-lane spawn.

The claim-held route-failure park (claim + note, no defer) stays
for what it was built for — deterministic config breakage (bad
`class:` label, broken chain, missing matrix profile) where
re-trying unchanged state cannot help.

### Unanswered policy — HOLD (chosen, documented)

Under enforce, `unanswered` holds exactly like `no-fit`: only a
confident pick spawns. Rationale: enforce's contract is
route-or-queue — the matrix exists to gate exactly the tasks it
cannot score, so falling back to the static lane on a dimmed judge
would make enforce a lie for its most important inputs. The
alternative (spawn-static, the class router's enforce-unanswered
posture) was rejected because a consistently under-confident judge
would silently un-enforce the whole fleet with no visible signal;
a hold is loud (note + journal + `bd` state) and self-corrects on
wake. `JudgeUnavailable` — the call itself failing — still fails
open: outage is infra, not a verdict.

## Verify

- `packages/judge/src/matrix.test.ts` — enforce returns the full
  verdict for pick/no-fit/unanswered (was pick-or-undefined).
- `packages/cli/src/commands/agents.test.ts` — enforce pick
  overrides the static lane end-to-end (provider+model+matrix
  provenance in the registry); high complexity never reaches the
  low-ceiling row under enforce; profile binding resolves
  piecewise; no-fit/unanswered/capability-only → SpawnError hold,
  no spawn; prose-grade judge provider under enforce → config
  SpawnError; JudgeUnavailable → warn + static spawn; explicit
  `--provider` outranks the pick; shadow tests unchanged.
- `packages/cli/src/commands/loop.test.ts` — `resolveLoopLane`
  matrix param: pick provider/model/autoApprove resolution and the
  flag > matrix > route > config precedence; routeSpec suppressed
  under a pick.
- Live smoke — fixture matrix + scripted systemone reply: shadow
  journals without lane change (unchanged); enforce routes the
  spawn to the picked lane; a no-fit verdict leaves the task
  queued (loop: deferred bead + note; agents up: SpawnError);
  judge-down → static fallback warned.
