# bro-aqjji — claim release is a no-op on in_progress beads

## Problem

Observed 2026-10-15: while the devin session quota stayed full
(`9/6 live`), each `bro loop` pass claimed the next labelled bead, hit
the quota refusal at spawn admission (`SpawnError 'cap'` in
`admitSessionSlot`), and **stranded the claim** — beads went
`in_progress` under an expired lease, no worker, no note, no deferral.
The next pass's foreign-claim guard then treated the loop's OWN stale
claim as foreign work.

Root cause: `settleSpawnRefusal`'s cap path calls `reopenBead` →
`TaskStore.reopen` → `bd reopen <id>`. But `bd reopen` only reopens
*closed* issues — on an `in_progress` bead it prints
"not closed (status: in_progress); nothing to do" and exits. The
release is a silent no-op: the claim never returns to `open`.

## Fix

`TaskStore.reopen` must mean "release to the open queue", not the
bd-verb's narrow closed→open reopen. `bd update <id> --status open`
covers both legs — verified: in_progress→open keeps assignee cleared by
the caller path, closed→open clears closed_at. Point the port's
`reopen` at `update --status open`; `bd reopen` is not needed (and is
the wrong verb for a live claim).

Every `tasks.reopen` caller inherits the fix: `loop.ts` (cap/refusal
settle), `act.ts`, `work.ts`.

## Test plan

- store port: `reopen` on an in_progress bead flips status to open
- loop: a 'cap' SpawnError on a claimed clump returns all members to
  open (regression for this bead)
