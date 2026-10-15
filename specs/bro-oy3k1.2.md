# bro-oy3k1.2 — frame-scoped queues + `bro queue`

Epic bro-oy3k1 child. The spec of record (`specs/bro-oy3k1.1.md`,
Frames section) gives every frame `{context, own queue, result}`; this
bead adds the queue half — intake, explicit rank, promotion to a frame.

## Model

A queue item is a bead. Membership and order are labels on the bead —
`queue:<frame>` + `qrank:<int>` — so the queue rides the same store,
survives dolt sync, and needs no second file format. Ranks step by 10
so a reorder touches one label, never renumbers the queue.

- `bro queue <subject…>` — intake: create an open task bead labeled for
  the current frame's queue, rank = max+10. Prints `queued <id> → <frame>`.
- `bro queue ls [--under F]` — the frame's queue, rank order, one
  `rank\tid\ttitle` row per item.
- `bro queue drill <id>` — promote: `drillDown` pushes a frame titled
  after the item under its queue owner; the item closes with the frame
  id as its close reason. Queue item → frame is the spec's push edge.
- `bro queue bump <id> [--to N]` — reprioritize: rewrite the rank label;
  `--to N` repositions, no `--to` floats to top (rank = min−10).
- `bro queue rm <id>` — dequeue without working it: strips the queue
  labels; the bead itself stays open (a queue drop is not a close).

Scope defaults to `currentFrame()`; no open drill frame scopes to the
session queue (`queue:root`) — frame #0's queue. `--under F` names any
open drill frame explicitly. Items on a *closed* frame's queue are
still listable under `--under` — a closed frame's leftover intake is
recoverable, never silently orphaned.

## Non-goals

- No dequeue-and-work scheduling (that's the rig engine's `.5` re-entry).
- No parent-child edges for queue items — a child would block the
  frame's `drill up`.
- No global reorder API beyond `bump` — explicit rank edits only.

## Acceptance

- `bro queue a; bro queue b; bro queue ls` shows `a` above `b`.
- `bump b` floats it to top; `--to` lands between ranks.
- `drill <id>` creates a drill child of the queue owner and closes the
  item bead; `bro drill` then reports the new frame.
- All ops survive a fresh process (state is beads-only).
