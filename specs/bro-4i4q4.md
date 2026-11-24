# bro-4i4q4 — remote-atomic claim: `bro claim task` / `bro next` claim on the shared dolt head

## Problem

`TaskStore.claim()` (`bd update --claim`) is exclusive only within the
local store replica — `claimCapability` already says so in so many words:
`authority: 'store'`, and "independently syncing replicas are separate
authorities, never one". Two agents on different machines (or two Devin
sessions sharing one project bd) both run `bro next`, both claim the same
top ready bead locally, and the collision surfaces only at the next
`bd sync` — as a dolt merge with two competing `in_progress` writers, at
which point both sessions are already working. Double-claimed work is the
most expensive failure a fleet scheduler can have: two branches, two PRs,
one wasted run.

The remote CAS point already exists: `refs/dolt/data` is the single head
every replica's `bd sync` pulls+merges+pushes against. A claim only
becomes real when it lands on that head; everything before the push is a
local draft.

## What changes

One new store-level helper — `claimRemote(store, id)` in
`@broject/core` (tasks.ts) — performs the claim as a three-step
publish-and-verify, and both claim surfaces go through it:

```text
claimRemote(store, id):
  1. store.claim(id)          — local claim; throws on a locally held claim
  2. store.sync?.()           — one dolt round-trip publishes the claim
  3. row = store.get(id)      — the post-merge truth
     won  := row.status is in_progress AND
             (actor === '' OR row.assignee === actor)
     raced := anything else  — the merged head carries another claim
```

Verdicts:

- **won** → true; the caller proceeds exactly as a local claim today.
- **raced** → false; the merged head proves another owner (or a close)
  won the publish race. Nothing to undo locally — the row already
  carries the winner's claim, so `claimRemote` must NOT `reopen` (a
  reopen would steal the winner's claim).
- **unprovable** → `store.sync()` throws (transport down, wedged
  replica, conflict bd refuses to merge): the local claim is a draft
  nobody else can see — undo it best-effort (`store.reopen`, failure
  swallowed — the sync error is the verdict) and rethrow. A claim that
  cannot be published must not pretend to exist.
- **no `sync` capability** → remote backends write through to the
  service on every op; the claim is already remote by construction. The
  helper skips step 2 and verifies by re-read — same verdict shape.

Actor `''` (unresolvable identity) keeps today's fail-open semantics:
`in_progress` alone decides. That is 'best-effort', matching
`claimCapability`'s honest declaration — callers that need the strong
guarantee need a resolvable actor.

### Integration

- **`bro next` / `claimUpTo`** — `claimOne` calls `claimRemote` instead
  of `store.claim`. A `raced` verdict falls through to the next
  candidate exactly like today's `racedAway`; a thrown sync/store error
  still propagates as a diagnostic. Loop/convoy reach `claimUpTo`
  through the same path — fleet claimers become remote-atomic without
  another call site.
- **`bro claim task <id>`** — `taskClaim` in `claims-store.ts` calls
  `claimRemote`; a `raced` verdict reports the standing holder through
  the existing `taskClaimAfterRefusal` path (same conflict shape the
  CLI already prints).

## Non-goals

- Batching claims under one sync. `claimUpTo(limit>1)` pays one sync
  per bead today — correct before fast; a batched publish-and-verify is
  a follow-up if it ever shows on a profile.
- Fixing bd's merge semantics. The verify step treats the merged head
  as authoritative regardless of which side bd's resolver picked — the
  claim outcome is read off the head, never assumed from the local
  write.
- Leases/TTL on task claims. `task:*` stays delegated to the task
  store; the claims table is untouched.

## Non-negotiables

- A raced claim must never `reopen` — the merged row belongs to the
  winner.
- An unprovable claim must be undone locally before surfacing the sync
  error — a draft claim left behind looks live to local readers but
  invisible to every other replica.
- `bro next` output must still say `(claimed)` only for remote-won
  beads — the work order is the contract.
