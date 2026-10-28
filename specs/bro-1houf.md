# bro-1houf — the spawn lane is declared, not remembered

## Problem

A spawn's lane — batch (the fleet's share of a shared provider account,
spec bro-9h86l) or interactive (the operator's own sessions) — is today
an **opt-in env pin each call site must remember to write**.

`StepSpawnRequest` (agents.ts) has no lane field. Callers that want the
batch lane hand-set `env[BRO_BATCH] = '1'`; the spawn prologue passes it
through; `isBatchSpawn` reads it downstream — `batchWallRefusal`
(agent-connectors.ts) refuses a walled provider and `checkSessionLanes`
(session-planes.ts) counts the worker against `maxBatchWorkers`. A call
site that forgets the pin produces a worker that is

- invisible to `maxBatchWorkers` — it spends the fleet's budget off the
  books;
- invisible to `batchWallRefusal` — it walks straight into a
  rate-limited provider and burns a doomed session.

That is not a hypothetical. Drill `bro-gblja` (2026-10-28) audited every
`spawnStepAgent` call site after devin hit repeated `rate_limited`
walls:

| Call site | Marked? | Verdict |
|---|---|---|
| delegate.ts, drive.ts, loop pins | `env[BRO_BATCH]` | correct — fleet |
| convoy-run.ts runner spawns | nothing | **bug** — fleet fan-out, fixed in [#757](https://github.com/ThePlenkov/bro/pull/757) |
| dogfood.ts:505 + :602 (runner, analyst) | nothing | **bug** — fleet work, still unmarked (bead bro-42rfh) |
| agents.ts (`bro agents up`, `agents run`), serve.ts:1927 | nothing | correct — operator/API surface, spec bro-9h86l |

The convoy fix marks that one path. It does not close the class: the
next spawn path added to the codebase will again silently inherit
neither wall nor cap, because silence is the default and the compiler
has nothing to check.

## Design

### `lane` is a required field

`StepSpawnRequest` gains:

```ts
/** The spawn's lane — REQUIRED, no default. 'batch' is the fleet's
 *  share (spec bro-9h86l): the provider wall holds it and
 *  maxBatchWorkers counts it. 'interactive' is the operator's surface —
 *  walled for nobody, counted only by maxWorkers. The prologue derives
 *  env[BRO_BATCH] from this field; callers never write the marker. */
lane: 'batch' | 'interactive';
```

Required, not defaulted — the fail-closed property lives in the type:
a new spawn path that never thought about lanes **does not compile**.
That is the whole point; an optional field with a default recreates
today's bug the first time someone forgets it.

The alternatives were considered:

- *default `batch` + interactive opt-out* — forgetting errs toward
  restraint, but it makes the marker a lie by default: an unlabeled
  operator spawn would be counted and walled as fleet work. Restraint
  is the safe failure for the ACCOUNT but the wrong truth for the
  registry.
- *keep `env[BRO_BATCH]` as the interface* — today's design; proven
  forgettable twice already.

### The marker is derived, never written by callers

The spawn prologue pins `env[BRO_BATCH] = '1'` into the worker's
environment iff `lane === 'batch'`. The env marker stays the wire
contract — the planes classify a LIVE worker from
`/proc/<pid>/environ` (spec bro-9h86l), so the pin must still ride into
the process env — but its only writer is the prologue. `lane` joins
the identity pins (`BRO_AGENT_ID`, `BRO_BEAD_ID`, `BRO_AGENT_PROVIDER`)
in the "the caller describes, the prologue pins" tier.

Conflicts fail loud, they are never silently reclassified:

- `lane: 'interactive'` with a caller-set `env[BRO_BATCH]` →
  `SpawnInputError` naming the conflict. Stripping the caller's marker
  would hide a classification bug; honoring it would make `lane` a lie.
- `lane: 'batch'` with a caller-set `env[BRO_BATCH]` → accepted
  (same outcome either way; not worth an error).

### Lane per call site — the migration

Every `spawnStepAgent` call site declares:

- **`lane: 'batch'`** — delegate.ts (delegation), drive.ts (fixers),
  convoy-run.ts `runnerSpawnReq` (replaces the hand-set pin landed in
  [#757](https://github.com/ThePlenkov/bro/pull/757)), the loop member
  pins (loop.ts), and **dogfood.ts runner + analyst** — fleet work
  spending the same account budget; this spec resolves bro-42rfh's
  open question as `batch`.
- **`lane: 'interactive'`** — `bro agents up` / `agents run`
  (agents.ts), and the serve API handler (serve.ts:1927).

The serve POST body shares the `StepSpawnRequest` shape, so a client
can send `lane`. The handler defaults an absent `lane` to
`'interactive'`; an explicit `'batch'` passes through — a client can
only opt INTO restraint, never out of it.

### Behavior change

Exactly one: **dogfood runner and analyst spawns become batch.** They
start counting against `maxBatchWorkers` and get refused while their
provider is walled — a `bro dogfood` run against a rate-limited devin
account waits like any other fleet work instead of burning a session
into the wall. Intended: they draw on the same account budget as the
rest of the fleet (drill bro-gblja).

No behavior change for the already-marked fleet paths (the pin is
derived instead of hand-set; the env the worker sees is identical) and
none for the operator surfaces (`'interactive'` is today's absence of
a marker made explicit).

`isBatchSpawn`, `batchWallRefusal`, `checkSessionLanes`,
`countSessionReservations('batch')` are unchanged — they read the env
the prologue pins, which is the same env, now guaranteed by the type
instead of by convention.

## Verify

- **The typecheck IS the enforcement** — every `spawnStepAgent` call
  site missing `lane` fails `npm run typecheck`; the migration list
  above is what the compiler enumerates.
- `agents.test.ts` — `lane: 'batch'` lands `BRO_BATCH` in the worker
  env; `lane: 'interactive'` + caller `env[BRO_BATCH]` throws
  `SpawnInputError`; `lane: 'batch'` + the same env key is accepted.
- `serve.test.ts` — a POST body without `lane` spawns interactive; a
  body with `lane: 'batch'` spawns batch.
- `dogfood.test.ts` — the recorded spawn spec carries the marker for
  runner and analyst.
- Live: `bro fleet agents status` counts a dogfood worker under the
  batch lane; a walled provider refuses a `bro dogfood` spawn with the
  wall message instead of letting it die `rate_limited`.
