---
parent: bro-7xgk
scope:
  - packages/core/src/agents.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/fleet.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/commands/webui.ts
---

# bro-7xgk.2 — exit cause taxonomy: rate_limited vs crash, and blocked vs lost

## Problem

The `.exit` record captures an exit code but the state machine collapses
every outcome into `running | exited | lost`. An agent killed by an
inference rate limit is indistinguishable from one that crashed, so
respawn treats a budget wall as a retryable death — a cause-blind
respawn converts an exhausted budget into a retry storm against the same
wall. On 2026-10-03 a molecule step exited rc=1 in 27s with
`Reached free model rate limit` and the only backoff in existence lived
in `/tmp/mol-queue2.sh`, outside the product.

## Design

### Taxonomy — `AgentCause`

`packages/core/src/agents.ts` gains:

```ts
type AgentCause = 'ok' | 'crash' | 'rate_limited' | 'quota' | 'auth'
```

`classifyExitCause(logTail, exitStatus)` is a pure classifier over the
agent's **log tail text, never the exit code** — the same rc=1 covers a
crash and a wall:

- exit 0 → `ok` regardless of text (a whining success is still a
  success);
- `rate_limited` — `rate limit`, `429`, `too many requests`,
  requests-per-window messages;
- `quota` — `quota`, `insufficient credits/funds`, `billing`,
  spending/usage-limit exhaustion (a budget wall with no per-window
  reset semantics);
- `auth` — `401`, `unauthorized`, invalid/expired token or API key,
  `not authenticated`;
- anything else on a non-zero exit → `crash`.

The classifier also extracts a **reset time** when the provider reports
one — `retry-after: N`, `try again in N s/m/h`, an ISO-8601 timestamp
after `reset`/`try again`/`until`, or an epoch-seconds `rate limit
reset` value. Result: `{ cause, resetAt?: ISO string }`.

### Registry — cause rides the entry

`AgentRegistryEntry` stays open-shaped; connectors write `cause` (and
`resetAt` when parsed) next to `exitStatus`. `AgentInfo` gains
`cause?: AgentCause` and `resetAt?: string` so every read surface can
show the classification.

`recordedDeath` in `agent-connectors.ts` is the harvest point — the
`.exit`-file branch patches `{ exitStatus, cause, resetAt }` in one
write, and the already-harvested `exitStatus` branch classifies lazily
when `cause` is absent (entries written before this feature). Only
backends whose wrapper writes `.exit` + a log classify this way
(native, tmux); gascity session states are unchanged.

### `blocked` — a budget wall is not a corpse

`AgentState` gains `'blocked'`. The recorded-death ladder returns
`blocked` (not `exited`) when the entry's cause is `rate_limited` or
`quota` and the block still holds — `rate_limited` holds until
`resetAt` passes (or indefinitely when the provider reported none);
`quota` holds until operator action. Once a `rate_limited` `resetAt`
passes the entry reads `exited` again and respawn is unblocked.

`lost` keeps its meaning — dead with no recorded death at all. A blocked
agent is a *waiting* worker, not a missing one: distinct state, distinct
handling.

`agentEntryBlocked(entry, now?)` in core is the shared predicate; drive's
registry-only `registryEntryState` maps the same way (recorded cause
only — it stays cheap, never opens logs).

Manual override: `bro agents down <step>` records `stopped`, which the
ladder already resolves first — the block lifts and respawn proceeds.

### Respawn refusal — the seam is `prepareSpawn`

After dedup's liveness check passes on a dead entry, `prepareSpawn`
re-reads the entry (harvest may have just classified it) and refuses
while the block holds:

- `rate_limited` → `SpawnError` naming the provider's reset time
  (`respawn of <step> refused — rate_limited until <resetAt>`); no
  reported reset → the refusal says so and names the clear path
  (`bro agents down <step>`);
- `quota` → refused the same way, cleared only by `down`.

The refusal lands inside the same locked critical section as the cap
check, so every caller (`bro agents up`, `drive` fixer respawn, `bro
serve` POST) gets it for free — the seam, not each call site.

A blocked entry occupies no fleet slot — it isn't burning budget —
so `entryOccupies`/`fleetOccupancy` need no change.

### Surfaces

- `bro agents status` — detail prints `cause`/`resetAt`; the table gains
  a `cause` column (`—` when absent); `--json` carries both fields via
  `AgentInfo`.
- `bro fleet` — a `blocked` agent renders `blocked — <cause>`, never
  `lost — respawn?`: the respawn decision surface is for corpses.
- `bro watch` — a blocked row surfaces as attention
  (`agent blocked — <step> — <cause>`).
- `bro agents down` / `stopAgent` — `blocked` joins `exited|stopped|lost`
  as terminal.
- `webui` fleet cell — `blocked — …` renders `warn`.

### Out of scope

`bro loop`'s raw `spawn('sh')` child is not a registry agent (same
boundary bro-7xgk.1 drew). gascity classification waits on gc exposing
per-session exit detail.

## Plan

1. Core: `AgentCause`, `AgentState +'blocked'`, `AgentInfo.cause/resetAt`,
   `classifyExitCause`, `agentEntryBlocked`.
2. `recordedDeath` classifies + persists cause/resetAt at harvest and
   lazily on read; `nativeState`/`tmuxState` surface `blocked`;
   `toInfo`/`toTmuxInfo` carry the fields.
3. `prepareSpawn` refuses respawn while the block holds, naming the
   reset or the `down` escape.
4. Surfaces: `agents status` (table + detail + json), `fleet` cell,
   `watch` attention, `webui` class, `stopAgent` terminal set, drive's
   `registryEntryState`.
5. Tests: classifier units (rc=1 crash vs rc=1 rate-limit text, reset
   parsing); connector-level — rate-limited agent reads `blocked`,
   registry carries cause, respawn refused with the reset; `down` clears
   the block and respawn proceeds.
