---
name: goal
description: "Use when the session needs a persistent completion condition it keeps working toward across turns — `/goal <condition>` sets it, the stop hook reminds (or judge-verdicts) whether it was reached. For hosts without a native goal command (devin). Requires `bro` (npx -y @broject/bro@0)."
---

# /goal (bro)

A goal is a session-scoped completion condition: the session keeps
working until a verdict — met, impossible, or turn budget — resolves
it. Bro's Stop hook re-injects the goal (or the judge's verdict on it)
after every turn; session-start restores it across resume/compaction.

## Commands

```bash
bro goal <condition…>    # set/replace — bare `bro goal` shows status
bro goal pause|resume    # suspend / reactivate (resume resets turns)
bro goal clear           # resolve (aliases: stop, off, reset, none, cancel)
bro goal --json          # machine form on every verb
```

Options: `--session <id>` pins the goal (default: `BRO_SESSION_ID`/
`DEVIN_SESSION_ID`/… env); `--turns N` sets the evaluation budget
(default `goal.maxTurns`, 25). `bro goal <condition>` run on a bare
shell — no session env — writes the **repo seed**: the next session in
this repo materializes it as its own. That is how
`bro goal "empty bd ready"` becomes the next worker's objective.
(Bare `bro goal` without a condition only shows status — it writes
nothing.)

Hosts with a **native** `/goal` (Claude Code) — use it; `bro goal`
stays the scriptable, cross-host, worker-spawnable surface.

## Writing a condition

One measurable end state + a stated check + the constraints that must
hold — the evaluator judges the condition against what the session
surfaced, so pick something tool output can prove:

```text
bro goal 'npm test exits 0 and git status is clean — or stop after 20 turns'
bro goal 'all threads on PR #412 resolved and `bro act status` green'
```

## The verdict loop

Every stop evaluates the active goal. With a judge configured
(`judge.provider` + `goal.judge` — default on) the verdict is a typed
choice: `met`/`impossible` clear the goal, `not_met` spends one turn of
the budget, exhaustion pauses it (`status: budget` → `bro goal
resume`). Without a judge the hook injects a plain reminder — context,
never a forced block.
