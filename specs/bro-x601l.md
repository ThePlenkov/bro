# bro-x601l — `fleet.providerCaps`: global provider session caps

## Problem

`agents.<kind>.maxSessions` caps a session *kind* on the host, and
`fleet.maxConcurrent` caps the fleet's own registry rows — but the
operator's actual budget is a **provider lane count**: the number of
live sessions one account can hold, shared by every process on the
machine that talks to that provider. The devin free-model quota locks
at ~8 concurrent live sessions (safe budget ~6), and the same class of
wall exists for every provider.

The gap is the census. Today's counts miss whole populations:

- **`bro serve`'s retained ACP sessions.** The conductor holds one acp
  session per client conversation on one shared peer process — the
  session plane counts the peer once while the account sees N sessions
  (related: bro-r0y65). Worse, the slot claims that cover them expire
  at `SESSION_SLOT_TTL_MS` (120 s): a conversation retained for an hour
  holds a claim nobody counts after two minutes.
- **Transitive ACP children.** A worker of one provider spawning
  another provider's CLI (`claude` → `devin acp`) consumes the second
  provider's lane; nothing charges it against that provider's cap.
- **Spawn refusals are not a lane the queue can park on.** A spawn that
  hits the real provider wall dies, burns an attempt, and the
  rate-limit wall only closes the lane *after* the failure is
  harvested (bro-zaydc's drain). The cap needs to be an *outer
  admission gate* that waits, not a failure discovered post-mortem.
- **`fleet.providerCaps` is parsed but dead config** (lands in #945):
  it reaches `cfg.fleet.providerCaps` and nothing reads it.

So the operator writes `fleet.providerCaps: { devin: 6 }` today and the
fleet still spawns past the account's real ceiling.

## Design

### The knob

`fleet.providerCaps.<provider> = N` — already parsed (global config
layer only, operator policy; a project/local layer setting it is
warned-and-dropped). `<provider>` is the **entry name in
`providers.<name>`** — a config value, never a vendor fact. Core stays
provider-agnostic: it knows providers as names plus whatever command
their entry carries.

### The census — one lane count per provider entry

For a provider entry `<name>`:

1. **Plane census.** The entry's `command` (acp/cli entries have one)
   resolves to a session plane via `commandCliName` +
   `sessionPlaneForCli` — the same resolution a spawn already runs.
   The census is the plane's `countLive` (the host-wide pid sweep:
   native workers, interactive sessions, `devin acp` peers retained by
   ANY `bro serve` instance on the box, ACP children spawned
   transitively by other providers' workers — they all write the same
   lock files) **plus** `countSessionReservations` on the kind's slots
   dir. This is the same census the kind quota uses, so the two caps
   judge one number.
2. **Registry fallback.** An entry with no counting plane (an `api`
   provider, or a `cli` whose basename no plane claims) admits against
   the local registry: entries carrying `provider === <name>` that
   still occupy (`entryOccupies`, fail-closed) plus the
   provider-namespaced reservation dir. The census is repo-local —
   documented limit: a plane-less provider cannot be counted
   machine-wide today.

A provider name absent from `providers` still gates (registry rows
record `provider` verbatim); a name with no matching rows and no plane
just counts zero.

### Pid-governed slot claims — the census survives retention

`.slot` claims stop being pure TTL files: each carries
`{at, pid}` — the claiming process's pid. `countSessionReservations`
counts a stale claim **whose holder is still alive** and reaps one
whose holder is dead (fresh claims count as before; old bare-timestamp
files keep TTL-only semantics — backwards compatible by content
shape).

This is what makes retained ACP sessions and transitive acp children
countable without a second bookkeeping layer: a `bro serve` conductor
that holds a session for an hour holds a slot for an hour, and the
account's real occupancy is what every admission sees. A crashed
holder's claims reap at the TTL — never a wedge.

### The gate — `admitSessionSlot` / `admitSessionStart` judge `providerCap`

Both admission forms gain `opts.providerCap: { provider, cap }`:

- `admitSessionSlot` (the spawn path) runs the provider-cap verdict
  **first** inside the kind's admission mutex — the outer gate — then
  the existing kind lanes (`maxSessions`, worker lanes, work budget).
  It is armed by `providerCap` alone: a provider cap with no kind
  quota still serializes, counts, claims and refuses.
- `admitSessionStart`/`admitSessionStartAsync` (the guard + the
  conductor's session facade) judge the same verdict inside the same
  section and report it through the existing `refusal` field — a
  refusal line the conductor already maps to a retryable status.

A **provider-namespaced admission** (`admitProviderSlot`,
`admitProviderSlotAsync`) covers plane-less providers: it locks
`sessionAdmissionLock('provider-<name>')`, counts
`callerCensus() + countSessionReservations(providerDir)` (the census
callback runs INSIDE the mutex — the spawn path passes its locked
registry walk, the conductor passes its in-memory session count), and
claims a `.slot` in `sessionSlotsDir('provider-<name>')`.

Refusals are `SpawnError('cap')` whose message carries the literal
cause token `provider_cap`:

```
provider <name> lane cap reached — 6 live + 1 starting > 6
(fleet.providerCaps.<name> in the global bro config) — cause: provider_cap
```

`kind: 'cap'` is deliberate — every downstream wait already keys on
it: the convoy polls, the drive reports `spawn-refused`, `bro serve`
answers 503. The conductor's refusal classifier gains `provider_cap`
alongside `RATE` so a capped request answers **429 + retry-after** —
a park signal, never a burned attempt — on both dialect mappers
(`turnError`, `openaiFailKind`).

### Wiring — every lane-opening path admits

1. **`prepareSpawn`** (fleet agents up, convoy, drive, every connector
   facade): after the route walk settles `spec.provider`, before
   `enforceFleetCap` — `providerCapLane(env, spec)` resolves the entry
   + cap; the provider's kind when a plane claims it rides the same
   `admitSessionSlot` call the session quota already makes (one claim
   covers all armed caps on the kind), a different-kind provider cap
   admits on its own plane, and a plane-less provider admits through
   `admitProviderSlot` with the registry census.
2. **The conductor** (`assertSessionCap`): `ConductorConfig.providerCaps`
   carries the map (read once at startup, `cfg.fleet.providerCaps`);
   the lane's provider name is its ENTRY key (`env.cfg.backend` per
   lane). The `extraLive: env.sessions.size` compensation is dropped —
   pid-governed claims make the conductor's own retained sessions
   visible in the census, so adding them again would double-count.
3. **The brokered transport** (`/api/v1/acp`'s `onSessionNew`): admits
   through the same `providerCap` path — its retained upstream
   sessions are exactly the lane population the cap exists for.
   The churn/wall refusals keep their order; the cap verdict joins the
   refusal surface as a retryable refusal (`resource_exhausted`-class
   wire error), not a transport failure.

### Ordering discipline

- The provider-cap verdict runs **before** the fleet cap inside
  `prepareSpawn`: an account-lane refusal must not be masked by a
  repo-local count.
- The rate-limit walls stay inner: `batchWallRefusal` still runs on
  registry state first (cheap, per-repo), the work-budget lane still
  parks inside `checkSessionLanes`, the rate-gate charge still runs
  last. The provider cap adds an outer admission — it never charges,
  so a refusal costs nothing.
- Multi-plane claims roll back on refusal exactly as the cross-kind
  path does today: a provider-cap refusal after an earlier kind
  claimed releases everything in the same catch.

## Verification

- `packages/core/src/session-planes.test.ts`: a stale `.slot` whose
  holder pid is alive counts; a stale slot whose holder is dead is
  reaped; claims write `{at, pid}`; `admitSessionSlot` with
  `providerCap` refuses 'cap' at the census ceiling, admits below it,
  and arms without a kind quota; `admitProviderSlot` serializes the
  caller census under the provider mutex.
- `packages/core/src/session-cap.test.ts`: `admitSessionStart` with
  `providerCap` reports the provider-cap refusal through `refusal` and
  claims when under the cap; providerCap-only admission still claims.
- `packages/cli/src/agent-connectors/core.test.ts` (and the spawn
  tests): a `providerCaps` spawn refuses 'cap' with `provider_cap` in
  the message at the census ceiling; a provider naming an acp entry
  counts the kind's census; a plane-less provider counts registry
  occupants; the refusal precedes `enforceFleetCap`'s.
- `packages/cli/src/commands/serve-conductor.test.ts`: `providerCaps`
  reaches `ConductorConfig`; a capped lane answers 429 with
  `provider_cap` in the wire error; retained sessions count through
  their own claims (no `extraLive` double-count).
- `npm run typecheck`, `npm run build`, targeted `npm test` runs, and
  the full `npm test` before the PR.

## Non-goals / limits

- A provider-less census across ALL repos is not built: the registry
  fallback is per-repo (the lock is per-repo); plane-covered providers
  count machine-wide because the planes do.
- A provider cap does not subdivide by account, model, or route —
  `fleet.providerCaps.devin` counts every lane the entry's CLI opens.
  Aliased entries (`devin` and `devin-acp` on one CLI) share the
  kind's census and can each carry a cap over it.
- `provider_cap` is a refusal cause inside `SpawnError('cap')`, not a
  new `SpawnErrorKind` — the wait/park machinery already keys on
  'cap', and a new kind would force every classifier to special-case
  the same verdict twice.
