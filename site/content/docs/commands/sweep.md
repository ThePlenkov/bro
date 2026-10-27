---
title: bro work sweep
description: Gated lifecycle disposal for closed beads — the backlog's outflow stage.
---

*Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`).*

Closed beads accumulate forever, and `bd prune` alone would burn lessons
nobody harvested. `bro work sweep` gates the burn on a harvest marker: a
closed bead is **harvested** when it carries the `sweep:distilled` state
label. The marker is the gate's only input — no heuristics, no second
channel.

| Command | What it does |
| ------- | ------------ |
| `bro work sweep status` | Read-only — harvested vs unharvested counts, age vs `sweep.olderThanDays`, the would-burn set |
| `bro work sweep distill [--dry-run]` | Materialize harvest work — learn-cited beads auto-mark `sweep=distilled`; the rest pour as an agent molecule (`bro flow convoy run` / `bro fleet agents up` executes them) |
| `bro work sweep run [--dry-run] [--force] [--no-flatten]` | The gated pipeline: gate → archive → sync-verify → `bd prune --older-than` → `bd flatten` |

## The gate

`run` refuses while unharvested closed beads are older than
`sweep.olderThanDays` (default 30). A closed bead with no `closed_at`
also blocks — a row that can't be dated can't be proven safe.
`--force` is the explicit override; the refusal is the feature, so use
it only when the burn is intended.

The archive must land inside the synced set (`.agents/` or the
configured debt dir — see [`sweep.dir`](/docs/configuration#sweep)) so
`bro work sync` carries it to the data ref before prune runs.
