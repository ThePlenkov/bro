# bro-9h86l — the batch lane's share of a shared account

## Problem

The devin account is shared: the operator's own interactive devin sessions
and bro's batch lane (drive fixers, loop members) draw on the same
budget. On 2026-10-20 in the bro repo the two failure modes showed at
once:

```
devin sessions: 4/6 live      # the operator's own sessions
devin workers:  4/4 live      # every slot held by a bro fixer
native-bcdd8a55 exited rate_limited
native-6b13c78e exited rate_limited
native-5d524e88 exited rate_limited
native-e95ee503 exited rate_limited
native-89ab9b97 exited rate_limited
```

Two distinct defects hide behind that picture.

**1. No account-level wall.** A rate-limited death is recorded per AGENT
(`cause: 'rate_limited'` + `resetAt`), and the fleet *renders* it
(`provider devin walled — rate_limited til …`). Admission never consults
it. The per-agent respawn guard (`guardExistingEntry`) only covers the
same molStep — and each fixer is a fresh step, so five spawns walked into
the same wall in a row. The wall is a fact about the ACCOUNT; bro stores
it per agent.

**2. No lane split on the worker cap.** `agents.devin.maxWorkers` is one
budget for two populations. The batch lane can take every slot, leaving
none for an interactive `bro agents up` — the operator's own work and
bro's batch work compete for the same pool with no precedence.

The interactive lane and the batch lane are not the same kind of work:
one is a person driving, the other is a fleet burning a backlog. They
share a budget, so the budget must know the difference.

## Design

### Batch lane detection

A spawn is **batch** when its env carries a supervisor marker:

- `BRO_PR` — a drive fixer (drive.ts spawns with `env: { BRO_PR, BRO_PR_URL }`);
- `BRO_MOL_ID` — a loop member (loop.ts pins `BRO_MOL_ID`).

Both are already in the spawn env, and the child's env is
`{ ...process.env, ...spec.env }` — so the marker rides into the worker
process itself. The devin plane already reads `/proc/<pid>/environ` (it
proves a landing with `BRO_AGENT_ID`), so it can classify a LIVE worker
by lane from the same source. The plane's own worker predicate stays
lane-blind; a new predicate reads the env.

### The lane split

`agents.<kind>.maxBatchWorkers` — an OPTIONAL cap on the batch lane's
workers, on top of the existing `maxWorkers`:

- the batch lane is refused when its live workers + reservations reach
  `maxBatchWorkers`;
- the interactive lane is unaffected — it may still use the whole
  `maxWorkers`;
- unset → today's behaviour (one cap for everyone), so the knob is
  opt-in and cannot change an existing host silently.

The plane gains an optional `countBatchWorkers` — same fail-closed
contract as `countWorkers`: a plane that cannot tell batch workers from
interactive ones refuses `'config'` at admission when the cap is armed,
never silently unguards it.

### The account wall

A rate-limited death writes a HOST-WIDE wall for that kind —
`<slots>/wall.json` = `{ until }` — next to the admission mutex, so the
wall is where the count is (the slots dir is already host-wide; the
registry is per-repo, which is why the wall cannot live there).

While the wall holds, a **batch** spawn for that kind is refused with the
reset time in the message. The interactive lane is not blocked by it: a
wall learned from a fleet backlog run is the fleet's problem, and the
operator's own session may still succeed (different model, separate
allowance, or the wall's reset already passed).

The wall is written where the cause is classified (the agent tail knows
the kind) and read at admission — the same place the worker cap is
checked, under the same mutex, so the count and the wall cannot race.

## Verify

- `packages/core/src/session-planes.test.ts` — a batch spawn is refused
  at `maxBatchWorkers` while the interactive lane is admitted; a plane
  without `countBatchWorkers` refuses `'config'` when the cap is armed;
  the wall refuses a batch spawn until its `until`, and an expired wall
  admits again; an interactive spawn is admitted through a wall.
- `packages/cli/src/session-planes/devin.test.ts` — a live worker whose
  `/proc/<pid>/environ` carries `BRO_PR` (or `BRO_MOL_ID`) counts as
  batch; one without them counts as interactive.
- `packages/cli/src/agent-connectors.test.ts` — a rate-limited exit
  writes the wall for the kind; the next batch spawn is refused with the
  reset time.
- Live: `bro agents status` shows the provider wall; a drive tick
  refuses to spawn into it instead of burning another fixer.
