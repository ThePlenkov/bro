# bro-olfvd.1 — smart routes: the route table, the router's health store, and the decision model

Child of bro-olfvd (specs/bro-olfvd.md) — the router as its own package.

## Problem

The router **serves** a catalog but never **chooses**. Two routing planes
exist today and neither is health-aware:

- `fleet.routing.<class>` (specs/fleet-routing/bro-1x7p.md) — a task
  CLASS → an ordered provider chain. Provider-first. The class comes from
  the bead or the step.
- `brouter.models.<id>` (specs/bro-n1p0s.md) — a model id → the candidate
  providers that serve it. Model-first. Static.

Neither reads health. The health signals live in four planes — the agent
registry's walls (`deriveProviderWalls`, packages/core/src/routing.ts), the
lane gate (`packages/core/src/lane-gate.ts`), the session cap
(`packages/core/src/session-cap.ts`), the occupancy plane
(`packages/cli/src/commands/agents.ts`) — and never meet the choice. So
the answer to "which model do I serve for this task?" is: whichever the
operator declared first, even when that lane is rate-limited to `resetAt`
or already holds every session.

## Design

### 1. The router's own store (S1)

The router is the thing that serves the models, so the router keeps the
ledger. One SQLite database, owned by `brouter`, written by the router:

- **drizzle-orm** over Node's built-in SQLite (`drizzle-orm/node-sqlite`).
  No native module, no server, no install step. `drizzle-orm@1.0.0-rc.5`
  ships the node:sqlite driver/session/migrator trio; the stable 0.45.x
  line has only better-sqlite3/libsql — the RC pin is deliberate, and the
  fallback (better-sqlite3/libsql) is written down in the milestone.
- `node:sqlite` needs no `--experimental-sqlite` flag from Node 22.13
  (Node docs: v23.4.0/v22.13.0 unflagged) — the repo's floor (≥22.18) is
  covered.
- `drizzle-kit` (dev only) generates the migrations from the schema.
- **Path**: `${XDG_STATE_HOME:-~/.local/state}/brouter/router.db`. Not the
  git common dir: brouter runs without beads, without the bus, without a
  git repo (spec bro-olfvd). bro's own state stays where it is.
- **Tables** — the ledger, three facts:
  - `usage(provider, model, window_start, requests, tokens)` — the
    router's own counters.
  - `limits(provider, model, reset_at, source, reason)` — the rate limit
    the router SAW (429 + resetAt), the wall.
  - `sessions(id, provider, model, started_at, ended_at)` — the sessions
    the router holds open.
- Every write is best-effort and never blocks a request: the store is a
  ledger, not a gate. A missing or unwritable store costs the numbers,
  never the run — the devin lane's precedent
  (packages/devin/src/usage.ts).

### 2. The route table (S2)

A route is a template file. TOML, `kind = "route"`, `version = 1` — the
plan schema's convention (PLAN_VERSION, `bro plan validate`,
`bro run <plan.toml>`), so the validator, the error shape and the version
pin are the ones the repo already has.

```toml
kind = "route"
version = 1

[routes.edit]
match = { type = "edit", complexity = "low" }
chain = [{ provider = "anthropic", model = "claude-sonnet-4" }]
onWall = "fallthrough"
prompt = "routes/edit.md"
```

- `chain` entries are `{provider, model?}` — the same honest id the rest
  of the router speaks (`<entry>/<model>`, no protocol, no invented names).
- `onWall` reuses the fleet's vocabulary (`park | fallthrough`) — the wall
  policy is already a router-level concept (spec bro-1x7p).
- `prompt` points at an **md file: prose for the decision model** (the
  rubric), the way SKILL.md is prose for an agent. Never a second schema:
  one machine dialect, one validator.
- The candidate universe is the served catalog — the epic's M2 makes
  `brouter.models` the whitelist. A route may name only a served
  (provider, model); a route naming an unserved model is a config error,
  never a skipped entry (the repo's "absent = off" rule).

### 3. Health (S3)

One read-model over the store, computed by code — never by the model:

```ts
type HealthSnapshot = Record<string, { available: boolean; reason: string; until?: number }>;
// key: "<provider>/<model>"
```

- Sources: the router's own ledger (usage inside the window; the wall it
  saw) plus the walls the router observes at call time (429 → resetAt).
- The fleet's planes stay bro's for now. When `bro serve` delegates to
  `brouter serve` (the epic's M4), the fleet's signals can be written INTO
  the same store — one read-model, two writers, each owning its rows.
- A walled (provider, model) is skipped by the resolver, with the reason
  attached. Health decides; the decision model only chooses among what
  health left.

### 4. The decision model (S4)

The judge — exactly the machinery `fleet.router` already uses
(packages/judge/src/router.ts):

- a typed `choice` question whose options are the **candidate routes**
  (already health-filtered); each route's criterion is its chain plus its
  md rubric.
- modes `shadow | enforce | off`: shadow journals the verdict and picks
  nothing, enforce honors a confident, on-criteria pick.
- fail-open: `JudgeUnavailable` is "no verdict", never a gate input — the
  caller keeps the statically resolved route.
- the journal kind is `route-pick`, beside `route-class`.
- the model may be a jev model served through the provider judge
  (packages/judge/src/provider-judge.ts — e.g. `typesafe/jev-1.13`), or
  any provider.

**The model picks a ROUTE. The chain and the health are the code's.** A
model cannot see a rate limit; it must never name a provider.

### 5. The resolver and the surface (S5)

- `brouter route "<task>" [--json]` → the chosen route, the candidate set,
  the health reason for every reject, the chain, the wall policy. The
  "why" is the product.
- `brouter routes list | validate`.
- The spawn path: `bro loop` / `bro fleet` ask the router for a route.
  `fleet.routing` classes become routes in the same table — the old
  section is the compatibility face, one table underneath.

## Milestones

Each milestone is its own bead under this one; SDD gates the code.

1. **S1 — the router's store.** drizzle + node:sqlite, the schema, the
   migrations, `brouter store` (path / migrate / stats).
2. **S2 — the route table.** The TOML schema and its validator,
   `brouter routes list|validate`, and the served catalog as the route
   table's candidate universe (the epic's M2).
3. **S3 — health.** The read-model over the store, `brouter health --json`.
4. **S4 — the decision model.** The judge over the candidate routes,
   shadow → enforce, journaled.
5. **S5 — the resolver and the spawn path.** `brouter route`, and
   `fleet.routing` folded into the same table.

## Non-negotiables

- The model never names a provider or a model. It picks a route; the code
  owns the chain and the health.
- Health is read, never guessed. A walled model is skipped, with the
  reason attached.
- Honest ids: `<entry>/<model>` everywhere.
- Absent = off: no route table → no behavior change; no store → no health,
  no gate.
- Fail-open everywhere: no judge → the static route; no store → the
  numbers cost, never the run.
- One table: `fleet.routing` and `brouter.models` become routes, not
  competitors.
- The store belongs to the router: brouter keeps working without beads,
  the bus, and a git repo.

## Risks

- drizzle 1.0 is still an RC tag (the stable line has no node:sqlite
  driver). The milestone writes down the fallback: better-sqlite3 or
  libsql, at the price of a native module.
- The judge is another LLM call on the spawn path. Shadow first; enforce
  only once the journal shows the router agreeing with what actually
  routed.
- Two routing planes exist today. The migration lands as an alias, never
  as a flag day.
- Until the gateway moves (the epic's M4) the store counts only the
  traffic the router itself served — a lane served by bro's own
  `bro serve` is invisible to it.

## Verify

- `brouter store migrate` on a tmp dir: the schema applies, a second run
  is a no-op.
- `brouter routes validate` rejects an unserved model, an unknown key, and
  a version above the schema.
- `brouter health --json` reports the wall the store saw (429 → resetAt)
  and the usage inside the window.
- `brouter route "<task>" --json` in shadow mode: the candidate set is
  health-filtered, the journal records the verdict, and the choice is NOT
  honored.
- `npm test` green; the route, health and journal tests are unit-level —
  no network, no judge.
