---

name: brouter
description: "Use when the model list a client shows is wrong, filtered, or empty — the router's served catalog, `bro router`, the route table and explain surface, or the brouter package boundary. Client model blocks (claude-code pilot) live in the client-adapters skill. Mechanics live in @broject/brouter; this skill carries the contract and policy only."
---

# /brouter (bro)

**Mechanics live in the `@broject/brouter` package.** bro is the rig
(workflow, fleet, review loop); the router is the other half — it serves
the model catalog and drives the agents behind it.

The thin-client adapters — rendering the catalog in each client's own
vocabulary (Claude Code's `modelPicker` and its kin) — are
`@broject/client-adapters`, a separate package (spec bro-0ykhg.6): they
break on CLIENT releases, not on routing changes. See the
`client-adapters` skill; `bro router client …` mounts them beside this
surface.

## The boundary

| Owns                                             | bro                          | brouter                 | client-adapters |
| ------------------------------------------------ | ---------------------------- | ----------------------- | --------------- |
| the served catalog (which models, which lane)    | reads it                     | owns it                 | reads it        |
| the client adapters (the model block per client) | —                            | —                       | owns it         |
| the protocol clients (an ACP client, `ask`)      | —                            | owns it                 | —               |
| the gateway itself                               | `bro serve` (until the move) | `brouter serve` (later) | —               |
| the agent workflow (skills, hooks, fleet, beads) | owns it                      | —                       | —               |

One-way: **bro depends on brouter, client-adapters depends on brouter —
never the reverse.** Both run without beads, without the bus, without a
git repo.

## The honest id

The router serves the truth; the id is `<entry>/<model>` — no protocol,
no re-spelling. A label is a label; the id is what the client sends.
What a CLIENT does with that id (its own filter, its own picker) is the
adapter's business — the router never renames a model to survive a
client's filter.

## Commands

| Command                                                                                   | What it does                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `brouter models [--json]`                                                                 | the served catalog, read off the running router                                    |
| `brouter clients [--json]`                                                                | the agent clients — installed / configured / connector / ready                     |
| `brouter client …`                                                                        | moved — prints `bro router client …` (@broject/client-adapters)                    |
| `brouter store path \| migrate \| stats [--path P] [--json]`                              | the router's own ledger — where it lives, what it holds                            |
| `brouter routes list \| validate [--routes P]`                                            | the route table — the routes, or the problems                                      |
| `brouter health [--json] [--path P]`                                                      | what can serve right now — the walls and the open sessions                         |
| `brouter route "<task>" [--routes P] [--type T] [--complexity C] [--priority P] [--json]` | which route serves this task — the route, the chain, and the why                   |
| `brouter ask "<question>" [--provider P] [--model M] [--explain[=SLICES]]`                | ask one agent — `--explain` says which agent served, which model, and what it cost |
| `bro router …`                                                                            | the same surfaces plus `client <id>` — bro's spelling (the wrapper)                |

## The explain surface

`--explain` answers WHY a request went where it went. The vocabulary is
SLICES, not levels — the user asks questions, so the flag names them:

| Slice    | What it answers                                                      |
| -------- | -------------------------------------------------------------------- |
| `route`  | the route, the chain, the candidates, every reject with its reason   |
| `model`  | the model that serves, and who pinned it (you, the route, the entry) |
| `health` | what the router knew at decision time — the walls, the sessions      |
| `cost`   | the turn's context and cost, and the ledger's window counters        |
- `--explain` — every slice. `--explain=route,model` — only those.
- `brouter route --explain` → stdout (the explanation IS the output).
  `brouter ask --explain` → stderr (stdout stays the answer, pipeable);
  `bro loop --explain` → stderr (stdout stays the run log).
- An unknown cost says **unknown**, never `0` — a provider that reports no
  cost is unknown, not free. Token counts are labelled `reported` or
  `estimated`.
- `brouter ask` routes through the table when one is declared: the chain's
  first acp entry serves, `--provider` still wins, and with no table the
  first acp entry answers. The explanation names WHICH rule fired.

## The route table

A route says WHICH models a task may land on and WHEN it fits. The table
is TOML (`kind = "route"`, `version = 1`); the md beside it is prose for
the decision model, never a second schema.

```toml
kind = "route"
version = 1

[routes.edit]
match = { type = "edit" }
chain = [{ provider = "devin-acp", model = "swe-2-max" }]
onWall = "fallthrough"
```

- `match` — the task's shape: `type`, `complexity`, `priority`. A route
  that pins a field needs the task to carry it; a route that pins nothing
  fits every task.
- `chain` — the models, in order, as the honest `<entry>/<model>` ids the
  router serves. `devin-acp` serves the swe-2 family: `swe-2-max` is the
  id devin's model list carries (the ACP lane's own catalog advertises
  the base id `swe-2-high`, and the `-max` composite pins it with the max
  thinking level), while `devin-acp/claude-opus-5` is not a model of that
  lane at all. A route whose chain contradicts what `brouter.models`
  declares for that provider is a config error (`routes validate` names
  it), never a silently skipped route.
- `onWall` — `park` or `fallthrough`, the fleet's vocabulary.
- the table's path: `brouter.routes` in `bro.config.json` (or `--routes`).

The DECISION MODEL picks the route; the chain and the health are the
code's. It is a judge (`brouter.router.provider` + `mode`): either a
lane the operator configured, or a model the ROUTER SERVES — proxied
through the router's own gateway, so jev, openai or anthropic can all
decide. A proxied model answers in prose (the gateway has no
`/v1/systemone` route), so it journals in `shadow` and is refused under
`enforce`.

## Config

`brouter.models` (bro.config.json) is the operator's model list — the
model→lane registry (spec bro-n1p0s); it is the served catalog's
whitelist as of the router's second milestone.
