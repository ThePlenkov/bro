---
title: Utility commands
description: setup, run, sync, cleanup, plugins.
---

| Command | What it does |
| ------- | ------------ |
| `bro setup [--beads] [--skills]` | Wire bro into the repo: check `gh`/`bd`, write `bro.config.json`, optionally `bd init --stealth` + formulas + skill wrappers |
| `bro next [--list] [--json]` | The autonomous loop's scheduler — claims the top ready bead and prints the work order |
| `bro run <plan.toml>` | Execute a [plan](/bro/plans/) — `kind` routes to the owning plugin, its `planSchema` validates, `runPlan` executes |
| `bro sync [--pull]` | Push/pull artifact dirs (`.agents`, ledger) on `refs/bro/data` — git memory outside the review surface, never a branch |
| `bro cleanup [--remote] [--dry-run]` | Delete local branches whose PR merged — merged state comes from `gh`, not `git branch --merged` |
| `bro plugins` | The live registry — name, skill, config section, summary |
| `bro wtf <complaint>` | Capture a complaint as a `wtf` bead |

## `bro next` — the autonomous loop

If the backlog exists, it was already confirmed — an agent shouldn't
re-ask "should I continue?" per item. `bro next` is the scheduler as
code: it reads `bd ready`, claims the top item (priority, then age),
and emits the work order:

```text
bro next    → implement → PR → bro act merge → bd close → bro next
```

The agent's loop is *run `bro next`, do what it says, repeat until
`state: idle`* — no per-item prompts. What it deliberately never claims:

- **Human gates** — beads titled `HUMAN GATE …` surface as `gate:` lines
  for the user to decide, once.
- **Epics** — surface as `epic:` lines; decompose into beads first.
- **Molecule steps** — beads with a parent belong to `bro convoy`.

`--list` previews without claiming; `--json` emits
`{ state, queue, gates, epics, moleculeSteps }` plus `bead` when
`state` is `task`. States: `task` — a bead was emitted; `gated` — open
items remain but none are claimable (stop for the human, not done);
`idle` — backlog empty.

## `bro sync` — the data ref

Runtime artifacts (ledger, skills state, memory) shouldn't poison the PR
diff reviewers read. `bro sync` pushes artifact directories to
`refs/bro/data` — a git ref outside `refs/heads`, so it never shows up as
a branch or in a PR.
