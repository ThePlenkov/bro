---
title: bro learn
description: Triggered lessons with evidence, confidence, and a memory that knows when to speak.
---

`bro learn` stores durable lessons for the moments they matter. A lesson
is a rule plus a trigger: hook events and optional terms, commands, paths,
tools, or failed-tool evidence decide when it surfaces.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro learn add --lesson "…" --on E… --evidence K:R…` | Store a manual lesson. `--on` and at least one `--evidence` are required; both are repeatable |
| `bro learn list [--json] [--source X] [--confidence X]` | List lessons, optionally filtered |
| `bro learn show <id>` | Print one lesson as JSON |
| `bro learn forget <id>` | Remove a lesson |
| `bro learn capture [--source drill\|retro\|act\|mol\|all] [--mol ID] [--dry-run] [--json]` | Distill finished artifacts into lessons |
| `bro learn probe <question>` | Ask the store first; a hit prints ranked lessons and a miss records the gap |

`bro learn probe` can also store an answer in its second phase with
`--lesson`, `--on`, `--match-terms`, `--match-commands`,
`--match-paths`, `--match-tools`, `--match-errors`, `--budget`, and
optional `--evidence`.
Manual evidence uses `K:R`: the supported kinds are `bead`, `pr`, `session`,
`command`, and `text`.

## Triggers and confidence

Each `--on` value is one of:

- `session-start`
- `prompt-submit`
- `post-tool`

`--on` is repeatable, so a lesson can fire on several events: `--on
session-start --on post-tool`. A comma-separated value (`--on
session-start,post-tool`) works too. Repeats of the same event collapse
to one entry.

Match keys are conjunctive across categories and disjunctive within a
category: terms match prompt or trace text, commands match command
prefixes, paths match touched paths, tools match tool names, and
`--match-errors` matches a failed tool landing. `--budget` limits how many
times one lesson may fire in a session; the default is one.

Evidence is part of the lesson, not decoration. One unverified evidence
item is `tentative`; independent evidence or a lesson that held under a
real gate can make it `established`. `proven` is a recognized confidence
value, but the current confidence ladder does not assign it.

## Where lessons appear

The learn connector probes at session-start, prompt-submit, and post-tool.
Each probe is fail-open and emits at most `learn.maxInject` lesson lines.
The per-lesson trigger budget is separate: it prevents one post-tool lesson
from nagging after every command.

```json
{
  "learn": {
    "enabled": true,
    "maxInject": 3,
    "sources": []
  }
}
```

`enabled` is the kill switch. An empty `sources` list allows every lesson
source; a non-empty list limits injection to known sources such as
`manual`, `probe`, or `capture:drill`.

## Learn versus `bd remember`

Use `learn` for conditioned knowledge:

> when `gh pr merge` runs, sweep review debt.

Use `bd remember` for context-free memory:

> this repo uses native TypeScript.

Memories are always-on context. Lessons wait for their trigger, so a
mistake does not become another permanent prompt paragraph. Run
`bro learn capture --dry-run` before turning a finished artifact into a
lesson; it renders the proposal without writing it.
