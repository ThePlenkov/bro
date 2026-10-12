---
title: bro flow loop
description: The autonomous backlog runner — claim, spawn, gate, close, repeat.
---

`bro flow next` is one scheduling step. `bro flow loop` IS the loop — it claims
each ready bead, spawns the configured agent in a fresh worktree, drives
the act gate, closes the bead, and repeats until the queue is idle or
gated. The flat scheduler lives in [bro flow next](/docs/commands/next);
planned group work is [bro flow convoy](/docs/commands/convoy).

| Command | What it does |
| ------- | ------------ |
| `bro flow loop` | Run until the queue is idle or gated |
| `bro flow loop --max N` | Cap the number of beads in this run |
| `bro flow loop --dry-run` | Print the next plan without changing state |
| `bro flow loop --agent '<template>'` | Override the configured agent — a value naming a configured `providers.<name>` spawns through the registry instead |
| `bro flow loop --provider <name>` | Pick a [provider](/docs/commands/providers) explicitly |
| `bro flow loop --profile <name>` | Apply a `fleet.profiles` preset |
| `bro flow loop --model <m>` / `--auto-approve` | Model override / acp permission policy for the provider lane |
| `bro flow loop --label a,b` | Only claim beads carrying one of these labels |
| `bro flow loop --batch N` | Clump up to N same-affinity beads per claim — one worktree, one worker, one PR (per-bead commits name their id; uncovered members re-queue on merge) |
| `bro flow loop --stack <name>` | Put each claimed bead on a named [stack](/docs/commands/stack) |
| `bro flow loop --max-open N` / `--disk-min-slots N` | Gate-stack cap / disk floor override (`0` disables the floor — pushes hold while free disk can't cover N×`loop.worktreeMb`) |
| `bro flow loop --json` | Emit the loop event stream as JSON |

The agent resolves like `bro fleet agents up`: a named provider runs its
registry entry (`acp` providers spawn the headless `acp-worker`; `cli`
providers substitute their command for the template), and a raw
`loop.agent`/`--agent` template stays the escape hatch —
`{promptFile}` expands to the generated work order. The agent runs to
completion — there is no per-agent time budget; its output appends to
`<git-common>/bro/loop/<bead>.log` and `bro review watch`/`bro fleet status` flag
silence past `loop.stallMin` as an advisory for the orchestrator, never
a kill. `mergeTimeoutMin`, `stallMin`, `fixRounds`, and `maxItems`
control the run; `--interval` controls gate polling. See
[`loop` config](/docs/configuration#loop).
