---
title: Utility commands
description: setup, run, sync, cleanup, plugins.
---

| Command | What it does |
| ------- | ------------ |
| `bro setup [--beads] [--skills]` | Wire bro into the repo: check `gh`/`bd`, write `bro.config.json`, optionally `bd init --stealth` + formulas + skill wrappers |
| `bro run <plan.toml>` | Execute a [plan](/bro/plans/) — `kind` routes to the owning plugin, its `planSchema` validates, `runPlan` executes |
| `bro sync [--pull]` | Push/pull artifact dirs (`.agents`, ledger) on `refs/bro/data` — git memory outside the review surface, never a branch |
| `bro cleanup [--remote] [--dry-run]` | Delete local branches whose PR merged — merged state comes from `gh`, not `git branch --merged` |
| `bro plugins` | The live registry — name, skill, config section, summary |
| `bro wtf <complaint>` | Capture a complaint as a `wtf` bead |

## `bro sync` — the data ref

Runtime artifacts (ledger, skills state, memory) shouldn't poison the PR
diff reviewers read. `bro sync` pushes artifact directories to
`refs/bro/data` — a git ref outside `refs/heads`, so it never shows up as
a branch or in a PR.
