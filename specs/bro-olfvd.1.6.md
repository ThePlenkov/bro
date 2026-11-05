# bro-olfvd.1.6 — the explain surface: why this agent, why this model, what the session cost

Child of bro-olfvd.1 (specs/bro-olfvd.1.md) — the router's own surfaces.

## Problem

The router decides and says nothing. A request lands on a lane, a model is
served, a turn costs tokens — and three questions have no answer anywhere:

- **why this agent?** — which lane served, and by WHICH RULE (the route
  table's chain, the operator's `--provider`, or the fallback).
- **why this model?** — who pinned it: the operator, the route's chain, the
  provider entry, or nobody (the agent reported it).
- **what did the session and its context cost?** — the tokens the request
  carried, the requests the router served, the money.

What exists today:

- `brouter route "<task>"` explains a PLAN — a task text — and stops there.
  It never touches a live turn.
- `brouter ask` picks an agent without saying why, and **never consults the
  route table at all**: the table the operator wrote does not govern the
  router's own request surface. The resolution is "the first acp entry in
  the config" — a fact with no provenance attached.
- The spawn path (`bro loop`) resolves a route through the table and drops
  the why: `routeTableLane` returns a `ResolvedClass`, and the reasons the
  resolver computed are discarded.
- The ledger has **no writer**. `recordUsage`, `openSession` and
  `recordLimit` are API with no caller outside the tests — so the health
  read-model has nothing to read, and "what did this cost" has no data at
  all. The spec's S1 built the ledger; nothing ever wrote to it.

A verbose flag alone would not fix this: the questions are different (route?
model? cost?), and one boolean would answer none of them precisely while
answering all of them vaguely.

## Design

### 1. One vocabulary of slices (core)

`core` holds the contract — the same split the health read-model already
follows (`packages/core/src/router-health.ts`):

```ts
export const EXPLAIN_SLICES = ['route', 'model', 'health', 'cost'] as const;
export type ExplainSlice = (typeof EXPLAIN_SLICES)[number];

export interface ExplainFact {
  label: string;    // the question this fact answers
  value: string;    // the answer
  because?: string; // why it holds — a fact without a reason is not an explanation
  source?: string;  // where it came from
}

export interface Explanation {
  slices: Partial<Record<ExplainSlice, ExplainFact[]>>;
}
```

The slice vocabulary is the whole public surface of the feature. Adding a
slice is a new fact group, never a new flag. `core` also holds the pure
renderer (`renderExplanation`) and the flag parser — both pure, both
dependency-free.

### 2. One flag, two spellings

`--explain` — every slice. `--explain=route,model` — only those. A bare
`--explain` must not swallow the next positional (the task text, the
question), so the subset is spelled with `=`; a value-less `--explain` is
the whole story. An unknown slice is an error naming the known ones — the
same shape as the table validator's "all the problems at once".

Levels (`-v`, `-vv`) are rejected on purpose: the user asks QUESTIONS, so
the flag names the questions. `verbose` says "more"; `explain=model` says
"which".

### 3. The slices

| Slice     | What it answers                                                                    |
| --------- | ---------------------------------------------------------------------------------- |
| `route`   | the route, the chain, the candidates, every reject with its reason, the entries health dropped |
| `model`   | the model that serves, and its PROVENANCE (who pinned it)                          |
| `health`  | what the router knew at decision time: the walls (reason + until), the open sessions |
| `cost`    | the turn's context and cost, and the ledger's window counters                      |

`route` is a superset of what `brouter route` prints today, so the plain
render becomes the `route` slice — the same facts, one vocabulary.

**Provenance** is what makes `model` an explanation rather than a label:

- `you` — the operator's `--model`;
- `the route <name>` — the chain entry pins it;
- `the provider entry` — `providers.<name>.model`;
- `the agent` — nobody pinned it; the agent reported the model it runs.

### 4. The ask path routes through the table

`brouter ask` is the router's own request surface; the table is the router's
own routing face. They must meet:

1. `--provider` names the lane — the operator's choice wins.
2. Otherwise, with a declared table: the resolved route's chain, and the
   first entry whose provider is a configured **acp** entry (ask speaks ACP;
   a gateway lane cannot answer it) — that lane serves, with the chain
   entry's model pinned.
3. Otherwise: the old resolution — the first acp entry in the config.

The explanation names WHICH rule fired. Absent = off: a repo with no route
table behaves exactly as before (the operator's repo has no `brouter`
section today — this changes nothing for it until a table is declared).

The decision model (`brouter.router.provider`) picks the ROUTE, never the
lane: the chain and the health are the code's business.

### 5. The ledger gets its writer

The ask path records the turn it served:

- `usage` — one row per (provider, model, hour bucket): requests + tokens.
- `sessions` — the session the ask opened, closed when the turn ends.

Both best-effort: a missing, locked or broken ledger costs the numbers,
never the run (the ledger is a record, not a gate). The window is the UTC
hour — the bucket the spec's `usage` table is keyed by.

This is what makes the `cost` slice non-empty: the first ask fills the
counters the second one reads.

### 6. Honest unknowns

The ACP protocol reports tokens when the agent reports them, and never
reports money. The `cost` slice therefore distinguishes:

- a number the provider reported (`reported by the agent`);
- an estimate bro computed (`estimated — 4 chars/token`, the conductor's
  own rule, labelled as an estimate);
- an unknown (`the agent reports no cost`).

**Never a zero for an unknown.** "No requests" and "could not look" are
different facts, and the cost slice must not look alike. Money stays
unknown until a provider reports it — a column of `0.00` would be a lie the
operator would bill against.

### 7. Where the explanation goes

- `brouter route --explain` → **stdout**: the explanation IS the output.
- `brouter ask --explain` → **stderr**: stdout stays the answer, pipeable.
- `bro loop --explain` → **stderr**: stdout stays the run log.
- `--json` → the explanation rides inside the JSON payload.

### The package design

| Package                  | Owns (this milestone)                                             |
| ------------------------ | ----------------------------------------------------------------- |
| `@broject/core`          | the explain contract: the slices, the facts, the pure renderer, the flag parser |
| `@broject/router-store`  | the ledger — unchanged this milestone; the writer lives in the serving path |
| `@broject/router-routes` | unchanged — the resolver's verdict is the `route` slice's source  |
| `@broject/providers`     | the ACP turn's usage — reported tokens ride out with the reply   |
| `@broject/brouter`       | the collectors and the surfaces: `route --explain`, `ask --explain` |
| `@broject/cli`           | the spawn path: `bro loop --explain` prints the route a bead lands on |

Nothing reaches back: the store knows no routing, the table knows no store,
the explain contract knows no IO.

## Non-negotiables

- A fact without a `because` is not an explanation — the renderer refuses to
  print a bare value.
- An unknown says "unknown" and names the source. Never a zero, never a
  silent omission.
- The explanation never lands where a consumer reads data: stdout only where
  the explanation IS the output.
- Absent = off: no route table → the ask path behaves as before; no ledger →
  the cost slice says the ledger could not be read; the run continues.
- Fail-open: the ledger write never fails the ask; the explain never fails
  the command.
- The explanation is a VIEW — it never changes the decision it explains.

## Risks

- **The explain grows.** A slice is a fact group, so the pressure to add
  slices is the pressure to add flags. The vocabulary stays at four; a fact
  that does not fit one of them does not get a slice.
- **The ask path changes behaviour for a repo WITH a table.** That is the
  point (the table must govern the router's own requests), but it is a
  behaviour change: the explanation is what makes it reviewable, and
  `--provider` remains the escape hatch.
- **The ledger's window is the hour.** A window is a bucket, not a session:
  the session's own cost is the turn's, and the window's counters are the
  scale around it. The two are reported separately for that reason.
- **The conductor is not in this milestone.** `bro serve` routes on its own
  plane (model → provider routes) and already journals `conductor.turn` per
  turn. Wiring the conductor to the router's ledger is the follow-up that
  makes HTTP-served lanes visible to the router.

## Verify

- `brouter route "<task>" --explain` → the route, the chain, the rejects,
  the model's provenance, the health, the ledger's counters.
- `brouter route "<task>" --explain=model` → only the model slice; an
  unknown slice is an error naming the four.
- `brouter ask "ping" --explain` → the agent that served and the rule that
  chose it, the model and who pinned it, the turn's context and cost; the
  answer still on stdout.
- Two asks in a row: the second one's `cost` slice carries the first one's
  requests and tokens (the ledger's writer).
- `bro loop --explain` → the route the bead lands on, with the reason.
- A provider that reports no cost → the slice says unknown, and the number
  it does know (tokens) is labelled reported or estimated.
- `npm test` green; the explain tests are unit-level — no network, no judge.
