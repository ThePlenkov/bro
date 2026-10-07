---
title: bro loop
description: The autonomous backlog runner — claim, spawn, gate, close, repeat.
---

`bro next` is one scheduling step. `bro loop` IS the loop — it claims
each ready bead, spawns the configured agent in a fresh worktree, drives
the act gate, closes the bead, and repeats until the queue is idle or
gated. The flat scheduler lives in [bro next](/docs/commands/next);
planned group work is [bro convoy](/docs/commands/convoy).

| Command | What it does |
| ------- | ------------ |
| `bro loop` | Run until the queue is idle or gated |
| `bro loop --max N` | Cap the number of beads in this run |
| `bro loop --dry-run` | Print the next plan without changing state |
| `bro loop --agent '<template>'` | Override the configured agent |
| `bro loop --label a,b` | Only claim beads carrying one of these labels |
| `bro loop --stack <name>` | Put each claimed bead on a named [stack](/docs/commands/stack) |
| `bro loop --json` | Emit the loop event stream as JSON |

The configured `loop.agent` uses `{promptFile}` for the generated work
order. `agentTimeoutMin`, `mergeTimeoutMin`, `fixRounds`, and `maxItems`
control the run; `--interval` controls gate polling. See
[`loop` config](/docs/configuration#loop).
