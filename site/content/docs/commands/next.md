---
title: bro flow next
description: The flat backlog scheduler — claim the top ready bead, emit the work order.
---

`bro flow next` is the scheduler as code. `bd` owns the queue; bro owns
picking: the top ready bead, claimed atomically, emitted as a work
order. The agent loop is one line — next → implement → PR → merge →
repeat.

| Command | What it does |
| ------- | ------------ |
| `bro flow next` | Claim and print the next ready work order |
| `bro flow next --list` | Preview the queue without claiming |
| `bro flow next --json` | Emit the scheduler result as JSON |
| `bro flow next --global` | Schedule from the user-level store (`bro store init --global`) |
| `bro plan run next.toml` | The same selection driven by a validated [plan](/docs/plans) — filters, limit, ordering, gates |

The scheduler ends in `task`, `gated`, or `idle`.

## What `next` never claims

- **Human gates** — beads titled `HUMAN GATE …` surface as `gate:`
  lines. A plan may opt them into the queue via `gates = "allow"`.
- **Epics** — decompose into beads first; an epic is never work itself.
- **Molecule steps** — a bead whose `parent` is a molecule belongs to
  `bro flow convoy`; the flat queue doesn't steal it. Epic children carry a
  `parent` too but stay claimable — next checks the parent's type, not
  just the field.
- **Foreign-scope beads** — ids outside this checkout's `issue_prefix`
  are reported, never claimed. `scope = "all"` in a plan opts out.
- **Coordination primitives** — coordination labels (`gt:slot`, the
  merge-slot semaphore family) are excluded `bd`-side before
  classification.

The gate, not a prompt, decides when a claimed task is done.
