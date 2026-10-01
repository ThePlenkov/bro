---
title: Utility commands
description: setup, run, sync, cleanup, plugins.
---

| Command | What it does |
| ------- | ------------ |
| `bro setup [--beads] [--skills]` | Wire bro into the repo: check `gh`/`bd`, write `bro.config.json`, optionally `bd init --stealth` + formulas + skill wrappers |
| `bro next [--list] [--json]` | The autonomous loop's scheduler — claims the top ready bead and prints the work order |
| `bro loop [--max N] [--dry-run] [--stack NAME]` | The autonomous loop itself — claim → worktree → agent → gate → close → repeat; `--stack` chains each bead onto the named stack |
| `bro stack push <bead> [--name S]` | Sibling worktree on `stack/<name>/<n>-<bead>` based on the stack tip — the chain a `gh pr create --base` targets |
| `bro stack list [name]` | The chain: position, bead, branch, base, worktree state, PR |
| `bro stack sync [name]` | After a member merges: retarget open child PRs + rebase child branches; dirty/locked worktrees are skipped, never touched |
| `bro run <plan.toml>` | Execute a [plan](/docs/plans) — `kind` routes to the owning plugin, its `planSchema` validates, `runPlan` executes |
| `bro plan` / `bro plan validate <file>` | Plan kinds and their schema versions · validate a plan without executing it (same pipeline as `bro run`, minus `runPlan`) |
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

The spawn env pins `BEADS_DIR` to the runner's store (`bd where`), so
every `bd` call inside the worktree hits the shared db even when the
repo tracks `.beads` or bd predates common-dir discovery. An agent's
`bd close` is honored as a verdict — a closed bead without a PR tallies
`closed` rather than being reopened as a phantom failure.

`bro loop --stack <name>` drives a chain instead of independent items:
each claimed bead becomes `stack/<name>/<n>-<id>` based on the current
tip, its work order names the PR base (`gh pr create --base <tip>`), and
a landed merge runs the `stack sync` cascade before the next item.

## `bro stack` — stacked PR chains

Work that builds on an unmerged sibling shouldn't wait for the merge or
hand-manage rebases. A named stack is an ordered chain of beads — member
N's worktree forks from member N-1's branch and its PR targets that
branch, so each diff stays reviewable while the parent is in flight:

```text
bro stack push bro-aaa --name payments   # stack/payments/1-bro-aaa off main
bro stack push bro-bbb --name payments   # stack/payments/2-bro-bbb off member 1
bro stack list payments                  # n · bead · branch · base · PR state
```

There is no stack registry to corrupt — membership is the
`stack/<name>/<n>-<slug>` branch namespace plus the `.git/bro/stack/`
base edges `bro work enter --stack` already writes. A deleted branch
simply drops out of the view; a repeated `push` of the same bead
re-enters its member branch instead of duplicating it.

Merges run bottom-up. When a member squash-merges, `bro stack sync`
retargets the open child PR onto the new base (`main` or the next live
member) and rebases its branch in place — a dirty or locked worktree is
skipped and reported, and the owner rebases when they re-enter. Sync is
idempotent: an in-sync stack reports nothing.

## `bro sync` — the data ref

Runtime artifacts (ledger, skills state, memory) shouldn't poison the PR
diff reviewers read. `bro sync` pushes artifact directories to
`refs/bro/data` — a git ref outside `refs/heads`, so it never shows up as
a branch or in a PR. It also runs `bd sync` — beads state (drill frames,
wtfs, the ready queue) has its own Dolt transport, not the data ref
(`sync.beads: false` opts out).
