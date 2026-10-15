# bro-oy3k1.5 — `rig next`: the single re-entry verb

Parent: bro-oy3k1 (one lifecycle state machine per work item; durable
state = beads + git-common registry + worktrees + forge).

## Contract

```
bro rig next [<item>] [--json] → step | gate | wait | done | blocked
```

The engine's one verb. Recomputed from durable state on every call,
idempotent, stateless — it never waits, never mutates, never invents
work. Any signal or timer re-enters the same probe; `convoy next` is
the DAG-specialized predecessor of this shape.

## Item resolution (no arg)

1. The current frame's queue top (`queueItems(queueScope())` — the
   intake answer: the next thing is whatever the frame queued first).
2. Else the current drill leaf.
3. Else the first `bd ready` row (dep-gated, store-owned order).
4. Else `done`.

## Verdict ladder (per item)

- bead closed → `done`.
- `waiting` label (a parked frame, .3) → `wait` — the WAKE: predicate
  is detail. A signal/timer re-enters, never a held process.
- an open PR on the item's worktree branch → `gate` — the next
  transition is a gate decision (threads, CI, human), carried by
  `act wait`/drive, not by this probe. Only merged/closed PRs and an
  open bead → `step` (finalize: `merged → closed` cleanup edge).
- live registry agent on the step → `wait` — a worker is mid-flight;
  its exit/signal re-enters.
- `in_progress` by another actor with no live registry agent →
  `blocked` — a foreign claim; nothing here moves it.
- `in_progress` (own claim, dead entry) or open+unclaimed → `step` —
  do work: claim+spawn is one transition (.4) or plain work.
- a ready() miss (deps unmet) on an open bead → `blocked`.

A queue item carries `detail: queue <frame> rank <n>` — promoting it
is `bro queue drill`, which frames it; the frame then re-enters as
`step`.

## Non-goals for .5

- Policies stay policies: `rig next` is the probe; folding `bro
  loop`/`bro drive` into policy-over-engine is the epic's tail, not
  this bead.
- No locking, no writes: verdict is a pure read — races resolve on
  the NEXT re-entry.
