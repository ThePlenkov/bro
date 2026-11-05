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
- The migrations are HAND-WRITTEN SQL (a list in the package), and a
  drift test proves the SQL and the drizzle schema agree — every table,
  every column (`PRAGMA table_info` against the schema). No generator,
  no codegen step, no folder to ship: the schema stays the source of
  truth for the queries, and the test is what keeps the SQL honest.
- **Path**: `${XDG_STATE_HOME:-~/.local/state}/brouter/router.db`. Not the
  git common dir: brouter runs without beads, without the bus, without a
  git repo (spec bro-olfvd). bro's own state stays where it is.
- **What the engine already is**: `node:sqlite` ships SQLite 3.53.4 with
  **FTS5** and **JSON1** — so text search and a JSON `meta` column are
  free, no extension and no native module. The ledger needs no more than
  that.
- **The ledger is vector-free, on purpose.** Embeddings are not a health
  fact: the ledger answers "who can serve right now". Semantic recall
  ("find me a session like this one") is a different domain — bro's
  session/lesson plane, not the router's — and when it becomes a real
  need it gets its own store: PGlite + the separate
  `@electric-sql/pglite-pgvector` extension (pgvector is NOT inside
  `@electric-sql/pglite`; it ships as its own package), one embedded
  process, no server. Until then, no vector column, no second engine, no
  WASM Postgres in the router's runtime.
- **Tables** — the ledger, three facts:
  - `usage(provider, model, window_start, requests, tokens)` — the
    router's own counters.
  - `limits(provider, model, reset_at, source, reason)` — the rate limit
    the router SAW (429 + resetAt), the wall.
  - `sessions(id, provider, model, started_at, ended_at, meta)` — the
    sessions the router holds open. `meta` is a JSON column (JSON1) for
    the tags a session carries (bead id, the bus sha), and those tags are
    INDEXED — "find me the sessions of that bead" is a filter, not a
    similarity search.
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

**The decision model may be a model the ROUTER SERVES.** The provider
is either a lane the operator configured (`providers.<name>`) or a served
model id (`typesafe/jev-1.13`, `openai/gpt-5`, `anthropic/claude-…` — the
served catalog is the router's own). A served model is proxied through
the router's own gateway: the decision model is just another model the
router fronts.

The wire follows the host. A lane may speak the systemone wire — the
native typed judgment. The router's gateway does NOT: its routes are
`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`.
So a PROXIED model answers in prose — prose-grade evidence, never a
calibrated judgment. Under `enforce` that is refused (the same typed-
grade gate the fleet's router keeps); under `shadow` it journals its
opinion and picks nothing. Closing the gap is one route on the gateway:
serve `/v1/systemone` and a proxied jev model answers in the typed
contract.

### 5. The resolver and the surface (S5)

- `brouter route "<task>" [--json]` → the chosen route, the candidate set,
  the health reason for every reject, the chain, the wall policy. The
  "why" is the product.
- `brouter routes list | validate`.
- The spawn path: `bro loop` asks the route table for the bead's route —
  the bead's class label is the task's type, the bead's priority the
  task's priority band. The verdict reuses the fleet's shape
  (`ResolvedClass`), so the spawn path downstream cannot tell which face
  answered. `fleet.routing` stays the compatibility face: a run that
  declares a route table gets the router's routing, a run that declares
  none keeps today's behaviour.

### The package design

One responsibility per package — the router's ledger, the router's
table, the decision model, the CLI:

| Package                     | Owns                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `@broject/router-store`     | the ledger: the drizzle schema, the migrations, the API, the health read-model |
| `@broject/router-routes`    | the route table: the TOML schema, the candidates, the resolver |
| `@broject/judge`            | `routePick` — the decision model, beside `routeClass`       |
| `@broject/brouter`          | the CLI surfaces: `store`, `routes`, `health`, `route`       |
| `@broject/cli`              | the spawn path: the loop asks the table for the bead's route |

`core` holds the shared contract (the health types, the wall policy,
the chain entry). Nothing reaches back: the store knows no routing, the
table knows no store, the judge knows no table.

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
- The router's gateway has no `/v1/systemone` route, so a proxied
  decision model answers in prose — usable in `shadow`, refused in
  `enforce`. Serving the typed wire is the follow-up that unlocks it.
- "Find the sessions of that bead / that sha" is a FILTER, not a vector
  search — an index answers it. A vector index would be the wrong tool
  for an exact key, and the wrong domain (the router's ledger does not
  own bro's session history). The semantic case ("find me something like
  this") is where PGlite + pgvector enters — its own store, its own bead.
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
- `brouter routes validate` rejects an unknown key, an empty chain, a bad
  `onWall`, and a version above the schema.
- the drift test: after the migrations, every drizzle table's columns
  match `PRAGMA table_info` — the SQL and the schema cannot drift.
- `brouter health --json` reports the wall the store saw (429 → resetAt)
  and the usage inside the window.
- `brouter route "<task>" --json` in shadow mode: the candidate set is
  health-filtered, the journal records the verdict, and the choice is NOT
  honored.
- `npm test` green; the route, health and journal tests are unit-level —
  no network, no judge.
