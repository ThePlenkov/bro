# bro-9h86l — the batch lane's share of a shared account

## Problem

The devin account is shared: the operator's own interactive devin sessions
and bro's batch lane (drive fixers, loop members) draw on the same
budget. On 2026-10-20 in the bro repo the two failure modes showed at
once:

```text
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

Both are already in the spawn's env, and the child's env is
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

### The account wall — derived, not stored

The repo already decided how a provider wall lives: **derived from the
registry, never stored** (spec bro-1x7p, `core/routing.ts`
`deriveProviderWalls`). This change does not add a second truth — it
makes the ADMISSION path read the wall the fleet already renders.

`batchWallRefusal(registry, spec)` — the decision, pure and testable:

- the spawn is batch (`isBatchSpawn`) and its provider is walled
  (derived from the registry, `until` in the future) → a `cap` refusal
  naming the provider, the cause and the reset;
- the spawn is interactive → no refusal: a wall the fleet hit is the
  fleet's problem, and the operator's own session may still succeed.

The scope is the registry — per repo. An account wall learned in another
repo is not visible here; the devin plane's own state is host-wide, but
the registry the wall derives from is not. That limit is stated, not
papered over.

## Verify

- `packages/core/src/session-planes.test.ts` — `isBatchSpawn` reads the
  supervisor markers; a batch spawn is refused at `maxBatchWorkers`
  while the interactive lane is admitted; a plane without
  `countBatchWorkers` refuses `'config'` when the cap is armed; the cap
  parses like every other lane knob (a typo refuses, never admits).
- `packages/cli/src/session-planes/devin.test.ts` — a live worker whose
  `/proc/<pid>/environ` carries `BRO_PR` (or `BRO_MOL_ID`) counts as
  batch; a lookalike suffix does not; an unreadable environ is not a
  batch worker (undercount, never a phantom).
- `packages/cli/src/agent-connectors.test.ts` — `batchWallRefusal`
  refuses a batch spawn while the provider is walled, leaves the
  interactive lane alone, ignores another provider, and admits again
  once the reset passed.
- Live: `bro agents status` shows the provider wall; a drive tick
  refuses to spawn into it instead of burning another fixer.
