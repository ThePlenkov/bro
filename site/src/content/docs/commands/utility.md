---
title: Utility commands
description: setup, run, sync, cleanup, plugins.
---

| Command | What it does |
| ------- | ------------ |
| `bro setup [--beads] [--skills]` | Wire bro into the repo: check `gh`/`bd`, write `bro.config.json`, optionally `bd init --stealth` + formulas + skill wrappers |
| `bro next [--list] [--json]` | The autonomous loop's scheduler — claims the top ready bead and prints the work order |
| `bro loop [--max N] [--dry-run]` | The autonomous loop itself — claim → worktree → agent → gate → close → repeat |
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

## `bro loop` — the runner, not just the scheduler

`bro next` emits one work order; an agent still has to execute the loop.
`bro loop` is the loop as a command: for each claimable bead it creates a
sibling worktree (`<repo>--<id>`, branch `loop/<id>`), spawns the
configured agent with the work-order prompt, then drives the merge gate
itself — green → `bro act merge`; review threads → the agent is respawned
with the findings (`loop.fixRounds` caps it); `bd close` and cleanup on
success, a `--notes` trail on failure.

```json
{ "loop": { "agent": "devin --prompt-file {promptFile} -p --permission-mode dangerous --respect-workspace-trust false" } }
```

`{promptFile}` is the work-order file bro writes into the worktree (also
works: `claude -p "$(cat {promptFile})"`, `codex exec "$(cat
{promptFile})"`). `--dry-run` shows the plan before anything is claimed.
One runner per repo — claims are atomic, so a second runner wastes agent
runs but can't corrupt the queue.

## `bro sync` — the data ref

Runtime artifacts (ledger, skills state, memory) shouldn't poison the PR
diff reviewers read. `bro sync` pushes artifact directories to
`refs/bro/data` — a git ref outside `refs/heads`, so it never shows up as
a branch or in a PR. It also runs `bd sync` — beads state (drill frames,
wtfs, the ready queue) has its own Dolt transport, not the data ref
(`sync.beads: false` opts out).
