---

name: brouter
description: "Use when the model list a client shows is wrong, filtered, or empty — the router's served catalog, the client model blocks (claude-code pilot), `brouter client <id> --write`, `bro router`, or the brouter package boundary. Mechanics live in @broject/brouter; this skill carries the contract and policy only."
---

# /brouter (bro)

**Mechanics live in the `@broject/brouter` package.** bro is the rig
(workflow, fleet, review loop); the router is the other half — it serves
the model catalog and renders it in each client's own vocabulary.

## The boundary

| Owns                                             | bro                          | brouter                 |
| ------------------------------------------------ | ---------------------------- | ----------------------- |
| the served catalog (which models, which lane)    | reads it                     | owns it                 |
| the client adapters (the model block per client) | —                            | owns it                 |
| the protocol clients (an ACP client, `ask`)      | —                            | owns it                 |
| the gateway itself                               | `bro serve` (until the move) | `brouter serve` (later) |
| the agent workflow (skills, hooks, fleet, beads) | owns it                      | —                       |

One-way: **bro depends on brouter, never the reverse.** brouter runs
without beads, without the bus, without a git repo.

## The problem it solves

The router serves the truth; the CLIENT decides what to show. Claude
Code's discovery keeps only the ids matching `/(claude|anthropic)/i` —
so an honest `<entry>/<model>` id never reaches the picker (measured
against the live gateway: 547 served, 89 survive).

The fix is a rendering, not a filter bypass: the served models, in the
client's own vocabulary, written into the client's own settings.

## Commands

| Command                                                          | What it does                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `brouter models [--json]`                                        | the served catalog, read off the running router                        |
| `brouter clients [--json]`                                       | the client adapters — id, title, settings key, settings path           |
| `brouter client <id> [--write] [--settings P] [--wire] [--json]` | render the model block; `--write` merges it into the client's settings |
| `brouter store path \| migrate \| stats [--path P] [--json]`     | the router's own ledger — where it lives, what it holds                |
| `brouter routes list \| validate [--routes P]`                   | the route table — the routes, or the problems                          |
| `brouter health [--json] [--path P]`                              | what can serve right now — the walls and the open sessions             |
| `brouter route "<task>" [--routes P] [--type T] [--complexity C] [--priority P] [--json]` | which route serves this task — the route, the chain, and the why |
| `brouter ask "<question>" [--provider P] [--model M] [--explain[=SLICES]]` | ask one agent — `--explain` says which agent served, which model, and what it cost |
| `bro router …`                                                   | the same surfaces, bro's spelling (the wrapper)                        |

## The explain surface

`--explain` answers WHY a request went where it went. The vocabulary is
SLICES, not levels — the user asks questions, so the flag names them:

| Slice    | What it answers                                                       |
| -------- | --------------------------------------------------------------------- |
| `route`  | the route, the chain, the candidates, every reject with its reason    |
| `model`  | the model that serves, and who pinned it (you, the route, the entry)  |
| `health` | what the router knew at decision time — the walls, the sessions       |
| `cost`   | the turn's context and cost, and the ledger's window counters         |

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

## The claude-code block

```jsonc
{
  "modelPicker": {
    "options": [
      {
        "model": "devin-acp/swe-2-high", // the honest id, verbatim
        "label": "devin-acp/SWE-2", // the catalog's own label
        "description": "devin-acp", // where it comes from
        "behavesAs": "claude-sonnet-5-5" // the handling it borrows
      }
    ],
    "replaceBuiltInOptions": true // Default + the served models
  }
}
```

- `behavesAs` — the model whose client-side handling (prompt profile,
  capability, effort defaults, context window) the row borrows. Without
  it the client warns "isn't recognized · context assumed to be 200k
  tokens". The targets are the CLIENT's, pinned to the client version —
  a client release retires them, not the catalog.
- `replaceBuiltInOptions: true` — the built-in lineup AND the client's
  own filtered discovery are hidden. Without it the served models are
  added after the built-in lineup and the filtered leftovers stay.

## Policy

- **Honest ids, always.** `<entry>/<model>` — no protocol, no
  re-spelling. A label is a label; the id is what the client sends.
- **No credential in a settings file.** The router's token rides the
  client's own credential mechanism; the wiring a client gets is ENV
  only.
- **The merge never eats.** Writing the model block preserves every
  other key of the client's settings.
- **Absent = off.** An unregistered client changes nothing; an unknown
  client id is an error naming the known ones.
- **The router never renames a model to survive a client's filter.**
  That is the client's business, and the adapter's.

## The order that matters

A client reads its settings at START — so the router must be up and the
settings must carry the block BEFORE the client starts:

1. the router is up (`bro serve`),
2. the client's model block is written (`brouter client claude-code --write`),
3. the client starts.

Step 2 without step 1 writes a stale catalog; step 3 without step 2
shows the client's own (filtered) lineup.

## Config

`serve.client.<client>` — where the block lands and which binary the
launch stage runs:

```jsonc
{
  "serve": {
    "client": {
      "claude-code": { "settingsPath": "~/.claude/settings.json" }
    }
  }
}
```

`brouter.models` (bro.config.json) is the operator's model list — the
model→lane registry (spec bro-n1p0s); it is the served catalog's
whitelist as of the router's second milestone.
