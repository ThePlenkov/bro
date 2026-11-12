# bro-36bhc — loop: honor the exit-cause taxonomy on worker settle

## Problem

`bro loop` respawns workers into a known provider wall — the exit-cause
taxonomy (spec bro-7xgk.2) classifies every registry worker's death
(`rate_limited`, `quota`, `auth`, `crash`, `ok`, with `resetAt` when the
provider reports one), and `convoy-run` already honors it: a
`rate_limited` death with a `resetAt` is a WAIT (sleep until the reset,
respawn the same molecule, no attempt burned); a quota wall with no
reset is a parked mol. The loop's settle never consults it.

Observed 2026-10-19: `bro loop` produced six consecutive
`exited cause=rate_limited` workers, each on a different bead, and kept
spawning — six provider sessions plus model requests spent against an
account-wide quota already at the wall, while the convoy supervisor
facing the same wall waited `resetAt` and resumed the SAME worker.

The mechanism, two holes:

- **The exit settle ignores the cause.** `serviceWorker` parks a worker
  whose state reads `blocked`/`stopped` — but a `rate_limited` death
  whose `resetAt` already passed at poll time reads `exited` with the
  cause still on it. That falls into `settleNoPr`: the bead reopens,
  the run claims the NEXT ready bead, and its spawn walks into the
  same wall — the churn, one wasted session per bead. (A sub-10s wall
  death parks as "environment crash" — the mislabel hides the wall
  behind the crash window.)
- **Pushes never see the wall.** A member blocked or dead on a provider
  wall is an ACCOUNT fact — a fresh claim's spawn burns a session on
  the same wall. `batchWallRefusal` (spec bro-1x7p) already refuses
  provider-lane spawns while a derived wall holds, but the settle side
  still pays the re-pick churn every interval, and a template-lane
  death derives no wall for the next claim at all.

## Design

Same contract as `convoy-run`'s `blockedDecision`, member-shaped —
the taxonomy already computed on the registry entry, never re-derived.

### The wall wait — `rate_limited` + `resetAt` is a hold, not a verdict

When a worker goes terminal without a PR, the settle reads
`info.cause`/`info.resetAt` (the classification `status()` just
harvested, same record `agentEntryBlocked` reads — AgentInfo-first like
convoy):

- `rate_limited` with a parseable `resetAt` → the member WAITS:
  `m.wallWaitUntil` arms, `m.worker` stays cleared, the bead's claim
  stays held (it is ours — the wall is not the bead's fault).
  - Reset in the future → wake exactly at the reset.
  - Reset already past at read time (provider clock behind the poll,
    or an unreliable reporter) → pace it: consecutive wall deaths on
    the same member floor the wait at 30s doubling to a 15m cap, so a
    provider that keeps lying about its reset cannot spin the loop
    back into the burn this fixes.
- At expiry, the FIRST worker respawns the same work order into the
  same worktree (the prompt file the push wrote is still there) —
  one respawn, no attempt burned. A `cap` refusal (fleet full, or a
  fresh wall a sibling death derived) re-arms the wait one interval;
  a `conflict` (a foreign owner picked up the step while we waited)
  releases the clump tail and ends the item; anything else parks loud.
- A `rate_limited` death with no usable reset, `quota`, or `auth` →
  PARK, the claim snoozes with the cause named — reopening is the
  respawn-burn. (`agentEntryBlocked` already reads `blocked` for the
  no-reset rate wall and quota; this settles the `exited`-shape cause
  the state read can't carry — `auth` dies `exited` and respawning
  into a 401 is the same waste class.)
- The agent's own verdict still outranks the wall: a worker that
  closed its bead settles `closed` first — no wait, no respawn.

### Fix/rebase workers — same wall, deferred gate

A fix/rebase worker's terminal read is currently `active` — an
immediate gate re-poll that spawns the next round into the same wall
(a real session burn on the template lane, a burned `fixRounds` slot
everywhere). The wall check runs there first: `rate_limited`+`resetAt`
defers the re-poll to the reset (the round the dead worker paid is
refunded — a wall death is not a repair attempt, matching convoy's
"no attempt burned"), and `quota`/`auth`/reset-less `rate_limited`
parks the member.

### The queue hold — a wall is an account fact

While any member sits in a wall wait, `tryClaim` holds pushes (the
drain check still runs — an empty queue behind the wall owes the done
verdict, not an infinite hold). Without it, `maxOpen > 1` claims the
next bead straight into the wall — each new member burns one session
before it can wait its own wall, the incident's exact shape.

### The spawn refusal — the derived wall sets the hold

`settleSpawnRefusal`'s `cap` already reopens + holds one interval
(fleet pressure is transient). When the refusal IS a derived provider
wall (`providerWallsFor` + the member's lane), the hold lasts until
the wall's `until` instead of churning claim→worktree→refuse every
interval — and a `quota`/indefinite wall parks the clump outright:
the bead's "park and report", never churn.

### Out of scope

- The legacy awaited `spawnAgent` path (`ctx.agents === undefined`,
  no beads store → no registry) has no taxonomy to consult — it keeps
  today's settle.
- Non-native connectors that don't classify exits — `info.cause`
  absent falls through to today's behavior.
- Mixed-provider queues: the member-level wait is provider-scoped by
  the lane it spawned on; the queue hold is deliberately broader (any
  wall wait holds pushes) — `batchWallRefusal`'s provider-scoped
  refusal already protects the common multi-provider case, and a
  conservative full-hold errs toward never burning.

### The devin double-session note

Checked in passing per the bead: the devin session plane counts live
sessions as pid-deduplicated lock files. A `devin -p` template worker
IS one devin process (one lock); if that process internally forks a
`devin acp` child it writes a second lock under its own pid — two
sessions counted, two account-side draws. The `--provider devin-acp`
lane runs `bro acp-worker → devin acp`: one devin process, one lock —
no doubling there. (Empirical check this host: the live loop worker
shows a single `devin acp` process per spawn.) The plane's
`startsSessions(command)` hook exists for exactly this — a command
known to double-spawn can declare 2; whether `devin -p`'s internals
actually fork `acp` is vendor behavior outside this fix's reach.

## Plan

1. `wallWaitUntil(cause, resetAt, now, waits)` — the pure decision,
   exported for unit tests: waitable rate wall → `max(reset, now)`;
   stale reset → `now + floor(waits)`; anything else → `undefined`.
2. `GateMember` gains `wallWaitUntil`/`wallWaits`; `serviceWorker`'s
   terminal settle consults cause before `settleNoPr` (after
   `agentVerdict`); `serviceMember` services the wait (respawn at
   expiry for first workers, `active` re-poll for PR members, round
   refund on arm).
3. `tryClaim` holds pushes while any member wall-waits; `QueueState`
   gains `wallHeld` for the once-per-episode line; the idle stage
   names the wait.
4. `settleSpawnRefusal` reads `providerWallsFor` on `cap` — wall
   `until` → hold till then; quota/indefinite → park the clump.
5. Tests: `wallWaitUntil` unit coverage (wait/stale-escalate/park/
   non-wall), e2e `wall` scenario (rate_limited+reset → wait →
   respawn → land, spawn count proves no churn; quota → park;
   two-bead wall → the second claim holds, one spawn total during
   the wall).
