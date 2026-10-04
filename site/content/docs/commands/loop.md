---
title: Backlog, loops & stacks
description: Schedule beads, run autonomous loops, stack PRs, and manage linked worktrees.
---

## `bro next`

`bro next` claims the top ready bead and emits one work order. It never
claims human gates, epics, or molecule steps owned by a convoy.

| Command | What it does |
| ------- | ------------ |
| `bro next` | Claim and print the next ready work order |
| `bro next --list` | Preview without claiming |
| `bro next --json` | Emit the scheduler result as JSON |
| `bro next --global` | Schedule from the user-level global store |

The scheduler ends in `task`, `gated`, or `idle`. The gate, not a prompt,
decides when a claimed task is done.

## `bro loop`

`bro loop` owns the full autonomous cycle: claim, sibling worktree,
configured agent, review gate, close, repeat.

| Command | What it does |
| ------- | ------------ |
| `bro loop` | Run until the queue is idle or gated |
| `bro loop --max N` | Cap the number of beads in this run |
| `bro loop --dry-run` | Print the next plan without changing state |
| `bro loop --agent '<template>'` | Override the configured agent |
| `bro loop --label a,b` | Only claim beads carrying one of these labels |
| `bro loop --stack <name>` | Put each claimed bead on a named stack |
| `bro loop --json` | Emit the loop event stream as JSON |

The configured `loop.agent` uses `{promptFile}` for the generated work
order. `agentTimeoutMin`, `mergeTimeoutMin`, `fixRounds`, and `maxItems`
control the run; `--interval` controls gate polling.

## `bro stack`

A named stack is an ordered bead → worktree → PR chain. Each member starts
from the previous member's branch, so dependent work can review before the
parent lands.

| Command | What it does |
| ------- | ------------ |
| `bro stack push <bead> [--name <stack>]` | Claim a bead and create or re-enter its stack member |
| `bro stack list [<name>]` | Show positions, bases, worktrees, and PR state |
| `bro stack sync [<name>]` | Retarget and rebase child members after a merge |

`--name` is required from the main checkout and inferred inside a stack
member. Sync skips dirty or locked worktrees instead of touching them.
`bro loop --stack <name>` drives the same chain automatically.

## `bro work`

Linked worktrees keep parallel sessions from colliding:

| Command | What it does |
| ------- | ------------ |
| `bro work enter <slug> [--branch <name>] [--base <ref>] [--stack]` | Create or enter a sibling checkout |
| `bro work leave [slug] [--force] [--delete-branch]` | Remove a worktree and optionally its branch |
| `bro work list` | List worktrees and clean/dirty state |
| `bro work prune` | Remove administrative entries for deleted worktrees |

`--stack` makes a new worktree base on the current worktree's branch; it
needs a checked-out work branch — from the main checkout's branch, the
default branch, or a detached HEAD it errors. `stack.mode` controls the
default: `manual` (default) requires explicit `--stack` or `--base`;
`auto` uses the current worktree branch when it is not the main
checkout's branch. The edge is recorded for bottom-up merge order.
