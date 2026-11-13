# bro-ejdn3 — nothing to judge: the class router stands on the resolved lane

Parent: specs/fleet-routing/bro-1x7p.md (M7 — the `fleet.router` judge
classifier). Sibling contract: specs/bro-v0pvd.1.md +
specs/bro-v0pvd.1.1.md (`fleet.matrix` — the same "nothing to judge"
gate, already defined). Bead: bro-ejdn3 — deferred review finding from
[#652](https://github.com/ThePlenkov/bro/pull/652) (delegate).

## Gap

A class-less spawn on a step that carries no judgeable text makes the
fleet router fire on **empty state**:

- `bro fleet delegate --detach` mints a phantom `adhoc-<hex>` molStep —
  never a bead. `spawnStepAgent` arms `fleet.router` (`req.class`
  undefined + routing declared + mode ≠ `off`), `stepClassInfo` reads a
  nonexistent bead → `info = {}`, and `applyFleetRouter` calls the
  judge with `{title: '', description: ''}` anyway.
- `bro agents run <prompt>` mints the same phantom — identical hole.
- A serve POST (or any `spawnStepAgent` caller) on a molStep with no
  bead, or a bead whose title AND description are both blank, is the
  same case.

Today the judge is asked to classify **nothing**: under `enforce` a
confident-but-contentless pick can land the work on an unrelated lane;
under `shadow` a judge call is spent and a `route-class` verdict
journaled for a classification of empty text. The behavior is
undefined — a dice roll, not a resolution.

`applyFleetMatrix` already carries the defined gate for exactly this
case: "`info` carries non-empty title/description (nothing to judge
otherwise)" — blank text returns `undefined` under shadow and a
synthesized `{kind:'unanswered'}` under enforce. The class router has
no equivalent check.

## Design

### The gate — mirror the matrix's, resolve by the router's own posture

`applyFleetRouter` (`agent-connectors/core.ts`) gains the same
nothing-to-judge condition the matrix already checks: when `info`
carries neither a non-blank `title` nor a non-blank `description`, the
judge is never consulted — no decide call, no journal row — and the
**resolved class stands, under every mode**.

The resolution is "resolved lane stands", not the matrix's enforce
hold, because the two routers are different contracts:

- The class router is a **re-classifier over an always-resolved lane**:
  `fleet.routing` resolves a lane (`--class` → `class:` label →
  `default`) before the router ever fires; `enforce` lets a confident
  pick win, and every non-pick outcome already returns the resolved
  class — a dimmed answer stands, an off-table pick stands,
  `JudgeUnavailable` stands. spec bro-v0pvd.1.1 names this posture
  outright: "spawn-static, the class router's enforce-unanswered
  posture". Nothing-to-judge is the same non-pick outcome — there was
  never a verdict to honor.
- The matrix is **route-or-queue**: under enforce it IS the lane
  authority, so a task it cannot score must hold (`MatrixHoldError`).
  That contract is untouched — `applyFleetMatrix`'s blank-text hold
  stays exactly as spec'd in bro-v0pvd.1.1.

Refusing class-less spawns under an armed router was rejected:
class-less is the router's *input*, not an error — `bro agents up` on
an unclassed bead is precisely what the router exists to re-class, and
delegate `--wait` already resolves the same ask to `default` statically
without a judge. A detach refusal would make `--detach` the only spawn
surface where "no `--class`" is fatal.

### Effect on `delegate --detach`

The reported surface resolves without touching delegate.ts:

- class-less `--detach` + routing declared + `default` lane exists +
  router armed (either mode) → **the `default` lane, zero judge
  spend** — the same lane `--wait` resolves for the identical ask.
- class-less `--detach` + routing declared + **no** `default` lane →
  the existing defined refusal: `routedLane`/`routeStepClass` throw
  `SpawnError` naming `fleet.routing.default` (kind `config`) before
  any spawn.
- `--class` detach → unchanged: the explicit pin withholds `info` from
  the router (`req.class === undefined` gate), the pinned lane stands.
- `--provider` detach → unchanged: the pin bypasses lane resolution.
- `fleet.matrix` enforce + detach → unchanged and already defined:
  blank task text is `unanswered` → `MatrixHoldError` (route-or-queue).
  Feeding the ask text to either judge — the reviewer's alternative —
  is a deliberately separate feature: the judge-state contract is bead
  `title`/`description`, and a phantom step has none.

### The latent hole closed beside it

`bro agents run`, serve POSTs, and any future `spawnStepAgent` caller
on a text-less molStep get the same definition for free — the gate
lives at the shared seam, not in delegate.ts.

## Verify

- `packages/cli/src/commands/agents.test.ts` — under `shadow` AND
  `enforce`: a class-less spawn whose step carries no
  title/description lands on the resolved `default` lane with **zero
  judge calls** and no `route-class` journal row. The two existing
  tests that exercised the router on text-less beads
  (`prose-grade`/`JudgeUnavailable`) gain a `title` so the judge still
  engages — their intent (router failure handling) is preserved.
- `packages/cli/src/commands/delegate.test.ts` — class-less `--detach`
  under `enforce` and `shadow` lands on `default` with no judge call;
  class-less `--detach` with routing but no `default` refuses the
  config error; explicit `--class` detach lands on the pinned lane
  untouched.
