# bro-ezboq — the serve lane's quota gate: pace acp spend before the account says no

## Problem

`bro serve` fronts agent clients (Claude Code via `ANTHROPIC_BASE_URL`)
with ACP backends. The fleet path got its rate gate in spec bro-y3jvd —
`providers.<name>.rateGate` arms a host-shared token bucket charged at
the spawn prologue — and that spec explicitly scoped OUT the interactive
surface: "the interactive lane is never throttled". The serve conductor
ended up with only *reactive* defenses:

- `AcpLaneCooldown` (bro-i6811) — arms AFTER the provider wall, refuses
  the next spawn until the window passes.
- `AcpDeadLoopGuard` (bro-b961a) — refuses churn per conversation/peer.
- `agents.<kind>.maxSessions` via `assertSessionCap` (bro-bww9v) —
  concurrency only, and account-wide by kind, never per-lane rate.

Nothing meters spend BEFORE it happens. Forensic 2026-11-13: Claude
Code → `bro serve` → dv-acp produced 648 `POST /v1/messages`, 324
`acp.spawn`, 297×429 / 81×529 / 54×500 in one day — every request that
missed session reuse paid a fresh `session/new` (expensive discovery
passes) until the shared Devin account hit its wall. `session_reused`
was false on effectively every turn: `conversationKey` fingerprints
prefix+first-turn, and one-shot calls (title-gen, probes, retries) each
mint a new fingerprint → new session → new spend. Reuse fixes cannot
cover the long tail of distinct conversations; only admission control
can.

`serve.limits.*` in `bro.config.local.json` already *looked* armed —
`limits.opencode-acp.{maxSessions,maxQueue,requestsPerHour,burst}` — but
the serve section parser drops unknown keys, so the knob was silently
inert (bro-56o2a's "config stops lying" case, on the serve surface).

## Design

A per-lane budget gate inside the conductor, consulted at the points
where provider spend is certain — never before, never after.

### Config: `serve.limits.<entry>`

```jsonc
"serve": {
  "limits": {
    "devin-acp": {
      "requestsPerHour": 240,  // bucket refill — ACP spend units/hour
      "burst": 60,             // bucket capacity — default requestsPerHour
      "spawnCost": 20,         // tokens per session/new (open+discovery)
      "turnCost": 1,           // tokens per ACP prompt turn — default 1
      "maxSessions": 3,        // per-lane concurrent session cap
      "maxQueue": 8            // per-lane in-flight turn cap
    }
  }
}
```

- Keyed by lane ENTRY (`devin-acp`, `opencode-acp`, the default
  backend's own name) — the same name `serve.providers`/routes resolve
  to. A limit absent for an entry leaves that lane ungated.
- `requestsPerHour`/`burst`/`spawnCost` reuse the `LaneRateGate` shape;
  `turnCost` is the serve-specific unit — one ACP prompt is NOT one
  provider request internally (an agentic turn loops), so the operator
  prices the multiplier honestly in config, exactly like fleet
  `spawnCost`.
- `maxSessions`/`maxQueue` are concurrency axes the token bucket
  cannot express: sessions held vs turns in flight.

### The bucket: host-shared, namespaced `serve:<entry>`

`laneGateTake` gains an optional `cost` (default `spawnCost`) so one
ledger primitive serves both fleet spawn charges and serve turn
charges. Serve ledgers key as `serve:<entry>/<model>` — a DISTINCT
namespace from fleet `providers.*.rateGate` buckets: fleet units are
spawn-lifetime estimates, serve units are per-prompt, and mixing units
in one bucket would lie. The account ceiling is shared, so the
operator budgets the two surfaces against each other in config (the
same discipline y3jvd asks of `lane:` aliases); a unified cross-surface
ledger is a follow-up, not this bead.

Ledger semantics inherit y3jvd wholesale: `$XDG_STATE_HOME/bro/
lane-gate/`, one JSON per key + filelock + tmp/rename publish, lazy
refill, corrupt/missing ⇒ fresh full bucket, clock-step-back never
drains.

### Charge points — where spend is certain

| Point | Charge | Why there |
|---|---|---|
| `continuationTurn` before `live.prompt` | `turnCost` | a warm-session turn still spends provider requests; replay returns BEFORE this line and pays nothing |
| `freshTurn` before `acpSessionRetain` | `spawnCost` | the session/new + discovery burn; refunded if the retain throws (no session, no spend) |
| `freshTurn` before `live.prompt` | `turnCost` | the retained session's first turn |
| `oneShotTurn` before `acpPooledTurn` | `spawnCost + turnCost` | open+prompt are fused inside the pool call — charged together, conservatively |
| `probeTurn` warm before `live.prompt` | `turnCost` | probes ride turns too; a cold probe falls into `freshTurn` and pays spawn |

A fresh retained turn therefore costs `spawnCost + turnCost`; a reused
turn costs `turnCost`; a replay costs 0 — the only path that provably
never reaches the provider.

### Refusals

`LaneBudgetError{kind, retryAfterSec}` → the `turnError` path learns a
third typed refusal beside `AcpDeadLoopError`/`AcpCooldownError`:
HTTP 429 + `retry-after` + `rate_limit_error` + a
`conductor.lanebudget` journal event (`{backend, kind, cost, retryAfterSec}`).
The refusal happens BEFORE `session/new`/prompt — it costs no session
and no quota, which is the entire point. `maxQueue`/`maxSessions`
refusals carry the same shape with `retryAfterSec` from the bucket (or
a short fixed wait for concurrency caps — the wait is "a slot frees",
not "tokens refill").

Ordering inside `freshTurn`: budget BEFORE `assertSessionCap` — a
budget refusal must not take a session-cap claim it then has to hand
back, and the cheaper check should fail first.

### What this does NOT do

- No mid-flight throttling — a running turn is never paused (that is
  the fleet wall-pause's SIGSTOP machinery, y3jvd §2, and it stays
  fleet-scoped).
- No per-request metropolis — one ACP prompt may be many provider
  calls; `turnCost` is the operator's honest multiplier, not a
  measured one.
- No change to reuse/fingerprint logic — orthogonal; this gate makes
  the churn AFFORDABLE to refuse, it does not fix why reuse misses.
- Interactive `bro agents up` spawns stay ungated here — y3jvd's
  split stands; this bead gates the serve surface only.

## Validation

- `lane-gate.test.ts` (core): `cost` override charges the passed
  amount, default stays `spawnCost`, refund path unchanged.
- `serveSection` tests: `serve.limits` parses per-entry, malformed
  entries drop, jsonSchema covers the shape.
- `serve-conductor-budget.test.ts`: bucket-empty ⇒ 429 + retry-after
  before any spawn; per-turn charge drains; spawn charge on open +
  refund on failed retain; reuse pays turnCost only; replay pays 0;
  `maxSessions`/`maxQueue` refuse; absent limits ⇒ ungated; ledger
  namespaces isolate `serve:` from fleet keys.

## Changelog

- **2026-11-13** — initial spec + implementation (PR #1066).
- **2026-11-13** — review round 1 (amazon-q threads on #1066):
  - `serveLaneLimits` now drops an entry whose bucket can never admit
    one open — `capacity = burst ?? requestsPerHour < spawnCost` is a
    config error, the same rule `providers.*.rateGate` enforces
    (bro-y3jvd). Previously such an entry armed a gate that refused
    forever with a retry-after that could never come true.
  - `serve.limits` jsonSchema rate fields moved from `minimum: 0` to
    `exclusiveMinimum: 0` — the parser's `> 0` rule and the schema now
    agree; `requestsPerHour: 0` fails validation instead of silently
    dropping to an ungated lane.
  - The spawn-refusal e2e now drains the bucket dynamically
    (spawn+turn charges) instead of relying on a statically
    impossible `burst < spawnCost` config that parse now rejects.
  - The `maxQueue` test synchronizes on the prompt reaching the fake
    peer (`holdPromptUntil`) instead of a 150ms wall-clock sleep.
