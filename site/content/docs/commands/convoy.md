---
title: bro convoy
description: Intentional group planning — a molecule's needs-DAG executed by claiming steps.
---

`bro next` is grab-anything mode: the top ready bead, whoever gets there
first. A **convoy** is the opposite — planned group work. A molecule
pours a formula into beads: steps are child issues, `blocks` edges are
the DAG, and every agent works the graph through `convoy next`/`done`
instead of freelancing the backlog.

A convoy survives session restarts, compaction, and parallel agents —
all state lives in beads, so `bro convoy status` reconstructs
everything.

## Running a convoy

```text
bro convoy pour <formula> [--var K=V]…  → molecule root id
bro convoy next    → what to do now (step / gate / blocked / complete)
bro convoy claim <step>   → atomic lease — refused if another agent holds it
bro convoy done <step> --result "…"   → close it, emit the new next
```

Repeat `next` → `claim` → work → `done` until `next` reports
`"state": "complete"`. `--result` is the handoff future steps read —
write what the next step needs, not a diary.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro convoy pour <formula>` | Instantiate a formula as a molecule |
| `bro convoy status [mol]` | The DAG — ✓ done / ▸ ready / · blocked |
| `bro convoy next [mol]` | Scheduler as code — the next executable step as JSON |
| `bro convoy claim <step>` | Atomic claim before starting — required with parallel agents |
| `bro convoy done <step> --result T` | Close the step, hand the result downstream |
| `bro convoy list` | Open molecules in this workspace |

## Human gates

A `type = "human"` step is a gate — it exists to stop the machine.
`next` reports it as `gate` and surfaces every ready gate in `gates[]`;
the convoy waits there for a person, not for an agent to improvise an
answer.

## Declaring convoys

Formulas are TOML — `formulas/*.formula.toml` — with steps, `needs`
edges, and `agent`/`human` types. A `kind = "convoy"` [plan](/docs/plans)
pours several molecules at once under one gate policy (`gates = "forbid"`
rejects any human gate — the unattended-run contract).

```toml
kind = "convoy"

[[molecules]]
formula = "ship-bead"
[molecules.vars]
bead = "bro-1234"
```
