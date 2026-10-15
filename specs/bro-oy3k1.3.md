# bro-oy3k1.3 — waiting-state on frames (the interrupter)

Epic bro-oy3k1 child. The spec of record (`specs/bro-oy3k1.1.md`,
Frames + `parked`/`release` item states): a frame that awaits an
external event parks with a wake predicate; the wake signal pops it
back — stack-of-queues, LIFO. Absorbs bro-zsmwq's round-robin
direction: a blocked frame yields instead of idling, and resumes when
its gate moves.

## Model

Waiting is a label, not a process: `waiting` on the frame bead + the
wake predicate recorded in its notes (`WAKE: <predicate>` — free text
the resumer reads, never machine-evaluated). No daemon owns the wait;
a mailbox drop or the next session's probe is what re-enters.

- `bro drill park [--id F] --wake TEXT` — the open frame (leaf or
  --id) suspends: `waiting` label + the predicate in notes. A waiting
  frame is no longer the current leaf — `currentFrame` skips it, so
  the interrupter honestly hands the session to the next active frame.
- `bro drill wake [F]` — release: drops `waiting`; no arg pops the
  most recently updated waiting frame (LIFO). The woken frame is again
  leaf-eligible on the next `currentFrame`.
- `bro drill waiting` — the wait stack, most-recently-parked first.
- `bro drill list`/`tree` mark waiting frames (`◌`/`[waiting]`), so a
  parked frame is never silently indistinguishable from an active one.

`drill up` on a waiting frame stays allowed with an explicit `--id` —
release-by-close is a legal edge (parked → closed); a bare `up`
targets the active leaf, which a waiting frame is not.

## Non-goals

- No automatic wake evaluation — the predicate is provenance for the
  resuming session, not a condition the CLI polls.
- No blocking wait verb — waiting costs a label, never a held process.
- Queue-side wake routing (mailbox signal → wake) lands with the rig
  engine's `.5` re-entry; this bead ships the state + the manual verbs.

## Acceptance

- `drill park` on the leaf removes it from `drill current`; the parent
  frame (or none) becomes current instead.
- `drill waiting` lists parked frames newest-first; `drill wake` pops
  the top and restores leaf eligibility.
- `drill up` without `--id` never targets a waiting frame.
- All state survives restart — it's beads-only.
