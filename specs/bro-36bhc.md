---

scope:
- packages/cli/src/commands/loop.ts
- packages/cli/src/commands/loop.e2e.test.ts
- packages/cli/src/commands/testrepo.ts
- skills/loop/SKILL.md

---

# bro-36bhc — fix(loop): honor exit-cause taxonomy — wait rate_limited resetAt instead of respawning into the wall

## Problem

Observed 2026-10-19: `bro loop` (pid 2441315) produced six consecutive
`exited cause=rate_limited` workers (bro-fa7wd, bro-e28ik, bro-61xv2,
bro-aa6re, bro-bhp6h, bro-1on9l) and kept spawning (bro-v2cn5,
bro-fe6f0). Each spawn burns a provider session + model requests
against an account-wide quota already at the wall — while the convoy
supervisor, facing the same wall, waited `resetAt` and resumed the
SAME worker without burning an attempt (specs/bro-7xgk.4.md
`blockedDecision`).

The spawn-admission half has since landed (bro-9h86l,
`batchWallRefusal`): a batch-marked spawn into a derived provider wall
refuses `SpawnError 'cap'` before any worker runs, so the registry-path
loop can no longer spawn six real workers into a known wall. What the
loop still does wrong is the _settle_ side — it doesn't consult the
taxonomy the registry already recorded:

1. `serviceWorker` reads a worker's terminal `blocked` state and parks
   the clump on the flat `loop.parkedWakeMin` snooze (default 2h). A
   `rate_limited` death carrying a provider `resetAt` should wake at
   the reset — the convoy waits the reset out and respawns; the loop's
   equivalent is a defer that ends when the wall lifts, not a blunt 2h
   cooldown that outlives a 15-minute wall (and still fires for a
   6-hour one).

2. `settleSpawnRefusal` reads every `'cap'` SpawnError as transient
   fleet pressure: reopen the claims, hold pushes one `--interval`,
   re-claim, re-probe. For a provider wall with a known `until` that is
   a per-interval claim churn for the wall's whole duration; for a
   `quota` wall or a `rate_limited` death with no reported reset it is
   an endless churn against a wall with no advertised end. The convoy
   contract instead: reset known → sleep until it, then spawn (no
   attempt burned); no advertised end → `parked`, reported, never
   waited into.

## Design

Apply the convoy-run `blockedDecision` contract at the loop's two
wall-facing decision points (registry path — `ctx.agents` set; the
awaited-template fallback has no registry to consult).

### Worker exit `blocked` → park on the wall's own clock

`serviceWorker`'s no-PR `blocked`/`stopped` settle keeps parking — the
claim must leave the queue — but the snooze is the wall's, not the
cooldown's:

- `rate_limited` with a parseable `resetAt` (the `blocked` read implies
  it is in the future) → `defer:` the reset itself. The bead wakes to
  `open` as the wall lifts; the next claim respawns a fresh worker —
  "sleep until the reset and respawn, no attempt burned". The worktree
  stays the resume cache as with any park. cause/resetAt come from the
  `status()` AgentInfo, with the bead's registry entry as fallback
  (same pair `blockedDecision` resolves).
- `quota`, `rate_limited` with no reset, `stopped` → the flat
  `parkedWakeMin` park, unchanged — a wall with no advertised end is
  reported, not timed.

`parkBeads` gains an optional `wakeAtMs`; when finite it overrides
`parkedWakeMin` (the park's whole point is the reset), still clamped
under the existing decade cap so a forged stamp can't RangeError the
defer write.

### Spawn refused `'cap'` → classify wall vs pressure

`settleSpawnRefusal` re-reads the refusal against
`providerWallsFor(ctx.root)` for the member's lane provider:

- Matching wall with `until` → release the claims (unchanged) and hold
  pushes until the reset: `PushOutcome 'hold'` gains `untilMs`, and
  `unseeClump` stamps `pushHoldUntil` from it instead of one interval.
  No claim churn, no probe storm — the batch lane waits, and the next
  post-reset pick spawns normally (or re-refuses and re-holds if the
  wall re-formed).
- Matching wall with no `until` (`quota`, or `rate_limited` whose
  provider reported no reset) → park the clump naming the wall —
  `{kind:'done', result:'parked'}`. Each queued bead parks once and the
  run reports its parked tally instead of spinning claim→refuse per
  interval forever; `bro agents down` stays the manual clear.
- No matching wall → the existing one-interval hold (a genuine fleet
  cap or session-quota refusal is transient pressure).
- `lane.provider` unset (raw `--agent` template lane) → no wall can be
  attributed — generic interval hold; the admission refusal still
  prevents any burn.
- `providerWallsFor` throwing → generic interval hold (a refusal is
  already proven; a broken wall read must not sink the settle).

Fix/rebase respawns (`respawnRound`) already un-burn the round on a
`'cap'` refusal — the refusal lands before any worker exists, so no
session is spent; the gate's normal interval re-poll retries. Out of
scope: per-provider holds under `fleet.routing` (a wall on one lane
holds all pushes — conservative, never a burn).

### `devin -p` session draw — checked

The bead's side question: does a `devin -p` worker's internal
`devin acp` child double-count a provider session? No — per
`devin acp --help` the REPL/`-p` frontend spawns an in-process
`devin acp` child, and that child IS the session; one worker = one
provider session either way (verified on the live rig: loop workers
are `bro acp-worker` → `devin acp` directly). No code change.

## Plan

- [ ] `parkBeads` gains `wakeAtMs` (finite → `defer:` that stamp,
  decade-capped; else `parkedWakeMin`)
- [ ] `serviceWorker` blocked settle: `rate_limited` + reset → park
  with `wakeAtMs = Date.parse(resetAt)` (info first, registry
  entry fallback) and name the reset in the note
- [ ] `PushOutcome 'hold'` gains `untilMs`; `unseeClump` consumes it
- [ ] `settleSpawnRefusal` 'cap': `providerWallsFor` match on
  `m.lane.provider` → timed hold / park / interval hold
- [ ] e2e: fake agent learns a per-bead wall map (one-shot
  rate_limited/quota death with log-tail text); tests cover
  wait-until-reset-then-land and quota-wall-parks-no-churn
- [ ] `skills/loop/SKILL.md` policy line: the park snooze rides the
  provider's reset when one was reported
- [ ] `npm test` (exact CI command)
