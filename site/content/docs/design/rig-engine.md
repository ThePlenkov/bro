---
title: The rig engine
description: One lifecycle state machine per work item — loop, drive and convoy are policies over it, not daemons of their own.
---

*Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`).*

bro used to run three supervisors that each owned a fragment of the
same lifecycle: **loop** claimed and spawned work, **drive** supervised
open PRs, **convoy** drained molecule DAGs. Every seam between them
leaked — a claim a spawned worker couldn't take, a worktree nobody
would create, a gate verdict computed three different ways.

The rig engine replaces that with one state machine per work item,
read from durable state. Beads, the agent registry, worktrees and the
forge are the authority; `events.jsonl` is history, never the source.

## Worktree = materialized WBS

Bead dotted-ids are WBS codes. A worktree per bead is a node, a stack
branch is an edge. Frames are `{context, own queue, result}` and nest:
drill pushes a frame, `bro queue` *(0.3.0)* enqueues into the current frame's
queue, a queue item can be promoted into a frame of its own.

Two traversal orders share the structure: a **queue of stacks**
(sequencer — convoy/DAG drainage, parent before child) and a **stack
of queues** (interrupter — a waiting frame parks with a `WAKE:`
predicate and pops back LIFO on wake).

## Waiting is state, not a process

A parked frame is a durable marker — `waiting` label plus the wake
predicate in notes. No process blocks on it; whatever signal or timer
fires re-enters the engine instead. The same rule applies to CI: a
worker pushes its PR, arms a detached `bro act wait`, and takes the
next item — the pipeline owns the waiter, never the session.

## `rig next` — the one re-entry point

`bro rig next [<item>]` *(0.3.0)* recomputes the verdict from durable state on
every call — stateless, idempotent, safe to invoke from any signal or
timer. It returns exactly one of:

| Verdict | Meaning |
| --- | --- |
| `step` | Work it — own claim resumed, or the queue/ready head |
| `gate` | A PR is open on the item's branch — threads/CI/human decide |
| `wait` | Parked frame or a live worker owns it — a signal re-enters |
| `done` | Nothing to do, or the item is closed |
| `blocked` | Foreign claim, unsatisfied deps, unknown id (exit 1) |

Loop's step pick and drive's settled-blocker resume are the same
ladder — policies consult `rig next` rather than re-deriving it.

**Sources:** `specs/bro-oy3k1.1.md` (state table + frame model) with
`.2` frame queues, `.3` park/wake, `.4` spawn-owned transitions, `.5`
the re-entry verb.
