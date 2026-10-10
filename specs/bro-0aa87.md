# bro-0aa87 — drive/loop mutual exclusion: supervised-marker occupancy

## Problem

Retro from the sverka night-run: while `bro loop` was running,
`bro drive --every` spawned a fixer (sv-6foe) onto PR #336 — the same
worktree the loop's agent was working in. Two writers, one tree.

Loop owns the whole lifecycle of its PR (claim → worktree → agent →
PR → gate → merge → close). But during the gate-poll and fix-round
phases none of drive's occupancy planes can see that owner:

- no facade agent — the loop's worker is a raw detached spawn, not a
  registry entry;
- no `.work` marker — that's a session-plane signal, the loop is a
  process, not a session;
- no worktree claim marker — `bro work enter` stamps those, the loop's
  `ensureWorktree` does not;
- `/proc` scan — empty while the agent has exited and the loop sits in
  the main checkout polling the gate (the dominant phase of an item's
  lifetime).

The PR reads as orphaned; drive adopts it. That adoption is both
redundant (the loop already drives threads/merge/close) and racy.

## Design

A **live watch marker is supervision proof**. One mechanism covers both
of the bead's options — the loop's gate members carry a live watch
marker for their whole tenure, and drive honors live foreign markers
as occupancy:

- **Loop arms a tenure-long watch marker per gate member** — since
  bro-zsmwq/bro-q6ppv the member's `watchBegin` marker already lives
  from push to `leave`, covering the markerless windows this bead
  originally targeted (fix rounds, `finalizeMerge`). What this change
  adds on top is the TTL bound: `loopWatch`'s `timeoutMin` is the
  item's worst case — `(agentTimeoutMin + mergeTimeoutMin) *
  (fixRounds + 1)` — so a marathon member can't TTL-prune its own
  supervision mid-tenure. Coverage is pid-liveness: a dead loop leaves
  a dead marker and the PR reverts to drive coverage automatically —
  which is exactly the recovery story (`bro act rearm` resurrects the
  wait as `act wait --merge --cleanup`; `bd reclaim` / the next
  `bro loop` re-claims the bead and re-enters the surviving worktree).

- **Drive treats a live foreign marker as occupied.** `occupied()`
  gains a `watches`/`pr` plane: a live marker for the PR whose kind is
  not `drive` (`loop`, `wait`, `convoy`, …) returns
  `supervised by <kind> pid <pid>`. Both verdict paths shrink for free —
  threads→`occupied` and green→`green-occupied` — and the in-lock
  occupancy re-checks in `spawnFixer`/`retireIfOrphaned` re-read
  `listWatches` so a supervisor landing mid-pass is still caught.

  Drive-kind markers self-exclude: two `bro drive` processes stay
  dedup'd by the fixer bead and the merge slot, and must not starve
  each other by mutual exclusion.

- **`emitWatchHeartbeats` stops claiming supervised PRs.** A `drive`
  heartbeat on a loop-owned PR would tell the session-start hook
  "watched" for a PR the pass actually skips — emit only for
  unsupervised open PRs, and retire this drive's own markers on PRs
  that became supervised (or settled).

### Why not the bead claim alone (option 1)

`loop/<slug>` → `store.get(slug).status === 'in_progress'` proves a
claim, not a live claimer — a crashed loop leaves the bead claimed
until `bd reclaim` reverts it. `lease_expires_at` can't fill the gap:
nothing in bro heartbeats `bd` claims, so the lease expires ~5min into
an item that can run an hour. Skipping on the bare claim would strand
dead loops' PRs; honoring the lease would re-race live ones. The
pid-checked marker is the claim's missing liveness proof.

## Non-goals

- No `--skip-loop-owned` flag — detection is unconditional and
  conservative; a flag adds a way to turn the safety off.
- No claim-heartbeating machinery in loop (`bd heartbeat` per item) —
  the marker carries liveness already.
- `work/`/`stack/` branches not driven by a live loop are untouched —
  ordinary orphan recovery is unchanged.

## Validation

- `drive.test.ts`: `occupied()` — live foreign marker → supervised
  verdict; dead pid → ignored; own `drive` kind → ignored; wrong PR →
  ignored. `emitWatchHeartbeats` skips supervised PRs.
- `npm test` (`tsx --test`) — the exact CI command.
