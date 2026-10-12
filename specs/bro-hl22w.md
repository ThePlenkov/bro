# bro-hl22w — parked beads release the claim into a snooze

## Problem

Every `bro loop` park path (merge-timeout gate, exhausted fixRounds,
closed/refused PR, environment crash, blocked worker, lookup failure)
settles the item by writing a `loop:` note — and nothing else. The bead
stays `in_progress` under a dead owner:

- it vanishes from `bd ready`, so `bro next`/`bro loop` can never see
  it again — the backlog stalls **silently** (the endAudit "claimed
  beads" tail is the only place it ever surfaces);
- the litter sweep's `releaseDeadClaim` intentionally skips it — a park
  is intent (`keepClaims`), not an orphan, and on the *next* run its
  worktree/branch still reads as a litter candidate whose claim the
  sweep only releases when a `loop/*` tail exists to judge;
- a human who wants the work resumed must `bd unclaim` by hand.

bro-sovl3 added the crash-window park to *stop* the `claim → crash →
reopen → reclaim` respawn-burn, so a plain `reopenBead` on park is the
wrong fix — it reintroduces the burn. What the park actually needs is a
claim release **with a cooldown**.

## Design

Park becomes a **snooze**: the note still names the wall, then the bead
is deferred — bd's own "on ice" status — with `loop.parkedWakeMin`
minutes of cooldown, and the assignee cleared. Deferred rows are hidden
from `bd ready` (the park's whole point: the next claim must not walk
into the same wall), honest in `bd list`, and releasable by `bd
undefer` at any time.

Two halves, both in existing seams:

### 1. Park = note + defer (loop.ts)

Every `parked` verdict path calls `parkBeads(ctx, beads, msg)` where it
today calls `noteOpen`/`noteBead`: gate-stack parks in `serviceGate`
(timeout, settled-blockers, closed, update-refused, fetch-exhausted),
worker-stage parks in `serviceWorker` (status-exhausted, lookup-error,
blocked/stopped), the crash-window park in `settleNoPr`, the
merge-finalize parks, the push-time PR-lookup park, and the
non-conflict spawn refusal (which today *reopens* — the defer is a
strict improvement over that instant re-queue; the conflict and
fleet-cap paths keep their reopen/lead-untouched semantics).

`parkBeads` writes the site note, then
`tasks.update(id, { defer: <wake ISO>, assignee: '' })`
(`{ status: 'deferred', assignee: '' }` when `parkedWakeMin` is 0 — the
indefinite icebox, `bd undefer` the only way back). A store that
rejects the write (down, or a backend with no defer concept) keeps the
old claim-hold — best-effort, never a crash.

### 2. Wake = the ready-front read (core/tasks.ts)

bd documents the snooze as "once `--until` passes, the next ready-front
read returns the issue to open automatically" — but bd 1.3.1's dolt
store never performs it (verified live: `defer_until` past, row still
`deferred`, still absent from `bd ready`). The TaskStore port
implements the documented contract: `ready()` first probes
`bd list --deferred` and `bd undefer`s every row whose `defer_until`
has passed, then runs the ready query. `taskStoreAsync.ready` does the
same. One probe extra per ready call; zero call-site changes — every
consumer (`bro next`, `bro loop`, status/planes, session-start) wakes
expired snoozes by reading.

A woken bead re-claims like any open bead: `planItemAndWorktree`
reuses the surviving parked worktree (the resume cache this keeps
meaningful), `findPr` re-discovers a still-open PR, and the gate
re-arms. `parkedWakeMin` bounds the retry rate — a permanently walled
bead burns at most one claim per cooldown, never a hot loop.

### Config

`loop.parkedWakeMin` — minutes a parked bead stays deferred before it
wakes to `open`. Default **120** — comfortably past a `mergeTimeoutMin`
gate cycle, short enough that a cleared wall retries the same session.
`0` = indefinite icebox (the old "leave it for a human" intent, minus
the dishonest `in_progress`).

## Non-goals

- No changes to `keepClaims`/the litter sweep — deferred beads are not
  `in_progress`, so the sweep's claim-liveness planes simply don't
  apply; `keepClaims` still guards a park whose defer write failed.
- No distinction between park causes — a closed-PR park snoozes like
  any other; rejecting the *work* permanently is a `bd close`, not a
  park policy.
- Remote (non-beads) task backends — a `defer` patch there is
  unsupported and degrades to the old claim-hold; beads stores are the
  home of the loop's claim semantics.
- `bro review drive` fixer beads — separate claim lifecycle.

## Validation

- `loop.e2e.test.ts`: every park scenario asserts `status: 'deferred'`
  (+ `defer_until` set, assignee cleared) instead of `in_progress`.
- New e2e: a bead seeded `deferred` with a past `defer_until` is
  claimed and landed by a normal run — the wake chain end-to-end.
- `loop.test.ts` (config): `parkedWakeMin` parses, `0` allowed,
  negatives/junk fall back to default.
- `npm run build`, `npm run typecheck`, `npm test` green.
