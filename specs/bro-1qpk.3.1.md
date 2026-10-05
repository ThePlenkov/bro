---
parent: bro-1qpk.3
---

# bro-1qpk.3.1 — `bro status --json`: compact board read for widgets

## Problem

A thin client (pi extension widget, future TUI/webui) needs live
project state every refresh tick. Today that means N shell calls —
`bd list`, `bd ready`, the agents registry, the drill stack, git
porcelain, `bro act status` — each with its own spawn cost. The
widget needs one read.

## Design

`collectStatus(dir)` aggregates the board in-process; the command
prints it compact or as `--json`:

```text
bro status            compact board — beads, fleet, drill, git
bro status --json     the same board, machine-readable
bro status --deep     + act exit gate for the current branch's PR
                      (network — the fast path stays local-only)
```

Shape: `{dir, branch, dirty, beads: {inProgress[], ready[],
readyTotal}, fleet: {maxConcurrent, agents[]}, drill: {frame},
act?}`.

- **Read-only, cwd-scoped** — nothing mutates.
- **Absent sections are empty, never errors** — a bead-less,
  registry-less, or `bd`-less checkout still answers (every source
  read degrades through `bdTry`/`gitTry`/try-catch).
- **ms-cheap** — `bd` reads via `bdTry` with a 15s bound, the
  registry is a JSON file in the git common dir, `ready` is capped
  at READY_CAP=10 rows with `readyTotal` carrying the real count.
- `--deep` is the only network path: resolves the current branch's
  open PR through the review-host connector and returns the act
  exit gate (`GREEN`/`BLOCKED` + blockers) — `null` when no PR or
  the probe fails.

## Plan

- [x] `collectStatus` — beads (bdTry), fleet (agents registry +
      pidAlive), drill frame (currentFrame, guarded), git porcelain
- [x] `render` — compact text board; `--json` emits the object
- [x] `readAct` — `--deep` gate read, try/catch → null
- [x] tests — bare repo answers with empty sections; dirty count
      tracks porcelain
- [x] `skills/status/SKILL.md` — the thin-client contract doc
