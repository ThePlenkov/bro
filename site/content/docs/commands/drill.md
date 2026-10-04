---
title: bro drill
description: Scoped descent — narrower investigation frames with mandatory results.
---

When a task needs focused investigation, `bro drill` creates a frame: a
`drill`-labeled bead nested under the current one. A frame can only close
with a result — and if it found a lesson, a prevention plan. **beads is
the memory system**; there is no `.drills/` directory.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro drill down <title> [--under ID] [--ephemeral]` | New child frame under the current leaf (or a root). `--ephemeral` = wisp, no audit trail |
| `bro drill up --result T [--prevent T]… [--evidence R]… [--report]` | Close the frame. `--result` is mandatory (CLI-enforced); each `--prevent` spawns a `prevention` task linked `discovered-from`; `--evidence` lands in `bd provenance`; `--report` writes a durable report |
| `bro unwind …` | Alias for `drill up` |
| `bro drill current` / `tree` / `list` | Active leaf · all hierarchies · open frames |
| `bro drill report` | List published drill reports |
| `bro drill distill <id>` | `bd mol distill` — a good drill tree becomes a reusable proto |

## Policy

Narrow → investigate → ascend → prevent. Descend only into a strictly
narrower problem. A frame that returns nothing teaches nothing; a frame
that found an error owes a prevention bead so it doesn't recur.

Hooks block Stop once while a frame is open — a repeated stop is let
through. Gates, not loops.

## Reports

`--report` writes `<drill.report.dir>/<id>.md`. The `drill.report` section
defaults to `{ "dir": "drills", "mode": "off" }`:

| Key | Values | Effect |
| --- | ------ | ------ |
| `drill.report.dir` | repo-relative path | Where durable reports live |
| `drill.report.mode` | `off`, `prompt`, `always` | Explicit reports only; ask on a TTY; or publish persistent frames automatically |

Ephemeral frames still require `--report` even when the mode is `always`.
