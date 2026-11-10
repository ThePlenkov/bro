# bro-b961a — dead-loop prevention in bro's ACP sessions

## Problem

bro's ACP layer counts nothing. There is no per-conversation attempt counter,
no progress detector, no stall watchdog, and no circuit breaker anywhere
between `session/new` and `session/prompt` (map: `packages/providers/src/acp.ts`
`acpSessionOpen` → `pumpTurn`; `packages/cli/src/commands/serve-conductor.ts`
`freshTurn` → `acpTurn`; `packages/cli/src/commands/serve-acp.ts` `onSessionNew`).

Every failure path is **evict and re-open next time**:

- the conductor's continuation turn fails → `evict()` drops the session →
  the next request on that key opens a brand-new one;
- the retained open's first turn fails → the handle is disposed, nothing is
  cached, the next request opens another;
- the brokered transport's turn fails → `evictDeadTurn()` → the client's next
  `session/prompt` hits `resourceNotFound` → the client issues another
  `session/new`.

The retry loop therefore lives **in the client**, and bro sees only a rising
tide of `session/new` calls. Nothing in bro observes it, so nothing in bro
stops it.

### The evidence (2026-11-09 incident, devin-acp listener on :4545)

From the Devin CLI's own log
(`~/.local/share/devin/cli/logs/devin_20261109-161524_139113.log`, 15:15:24Z →
16:12:45Z):

| minute | `session/new` | `session/prompt` |
| --- | --- | --- |
| 15:15 | 37 | 9 |
| 15:17 | 37 | 9 |
| 15:20 | 37 | 9 |
| 15:31 | 74 | 9 |
| 15:33 | 37 | 9 |

**222 session opens against 54 prompts.** 76 % of the sessions were opened
and abandoned without a prompt. Each open pays the agent's full setup —
five discovery passes over the operator's `$HOME` (`rules discovery`,
`plugins discovery`, `skills discovery`, `hooks discovery`, …), `errors=272`
per pass, **1162 discovery cycles** in 57 minutes.

The Devin free-model limit is **per-account concurrent**, not per request
(lesson `learn-devin-free-model-limit-is-per-account-co`); the operator's own
session hit the wall and the account was locked for five hours. bro was a
standing consumer of that budget.

The same incident also showed a second, quieter cost: the conductor's
session-cap claim (`assertSessionCap` → `reserveSessionStart`) is **never
released on the failure path** — it only expires with the 120 s slot TTL
(`packages/core/src/session-planes.ts`). A client retry loop therefore
converts into cap exhaustion on top of the quota burn.

### Why the guard must be client-independent

The loop's driver is the client (Claude Code, Codex, Cursor, bro's own loop
— whoever retries). A guard bolted onto one client is worthless: the next
client repeats the burn. The guard belongs to **bro's ACP layer**, so every
client gets it, and none can opt out of it by being a different client.

## Design

One module, `packages/providers/src/acp-guard.ts`, three guards, one config
section. The guards are *accounting*, not heuristics: every one of them
counts something bro already knows.

### G1 — the scope churn guard (the loop breaker)

A **scope** is one conversation: the conductor's conversation key
(`x-bro-session` pin or the history fingerprint), the brokered transport's
client connection. Per scope the guard keeps one counter over a rolling
window:

- `open(scope)` — a session is about to be opened. `pending` grows.
- `done(scope)` — a turn completed. The session it opened is resolved, so
  `pending` falls by one.

The **dead-loop measure is `pending`**: sessions opened and not yet
completed. A healthy conversation keeps it at zero (one open, one
completion). A retry loop makes it climb — each attempt opens a session
that never answers.

When `opens − done` exceeds `maxOpens` (default **8**) inside the window
(default **60 s**), the scope is a dead loop:

- the guard **throws** `AcpDeadLoopError` — the request is refused *before*
  the session is opened, so the refusal costs no quota at all;
- the scope stays refused for `cooldownMs` (default **60 s**), then a single
  probe is allowed through (half-open). A completed turn clears the trip
  outright — a working conversation is never stuck behind a stale refusal.

The error is loud by construction: it names the scope, the count, and the
budget, and the conductor maps it to **HTTP 429** with `retry-after`.

### G2 — the peer breaker (the loop may live in the child)

A scope can be healthy while the **peer** churns: the agent's own per-session
setup can loop inside the child, and the child keeps burning the account
while bro waits. The guard keeps the same `opens − done` measure per
**peer** (the spawn label — `conductor:<entry>`, the transport's backend).

When a peer's difference exceeds `maxAbandoned` (default **32**) inside the
window, the peer is broken: the pool **kills the child** and the next request
respawns it. A fresh child with no loop state is the only cure for a loop
that lives inside the old one — the same reasoning as the idle release
(spec `bro-7ira8`): dropping a handle without killing the process buys
nothing.

The break is loud: the in-flight request fails with the churn named, and an
OTLP event records it.

### G3 — the stall watchdog (the chokepoint)

`pumpTurn` is the **single point every ACP turn passes through** — the
conductor pool, the `/api/v1/acp` transport, the fleet `acp-worker`, the
judge, `bro acp proxy`. It is therefore the one place where a guard is
client-independent *by construction*.

Today the only bound on a turn is the caller's total deadline (120 s for the
conductor, **30 minutes** for the brokered transport). A turn that produces
no `session/update` at all — an agent that spins, waits, or dies quietly —
holds that budget for the whole time.

The watchdog bounds the **silence**: no `session/update` for `stallMs`
(default **300 000** = 5 min) ends the turn with
`acp <by> unavailable — turn stalled: no session/update for 300000ms`.
The stall window is per turn and resets on every update, so a long tool call
that reports itself is fine; a turn that says nothing for five minutes is
not. `0` disables it.

### G4 — the cap claim is released on failure

The conductor's session-cap claim is released when the turn fails, so a
retry loop no longer converts into cap exhaustion on top of the quota burn.
The claim's TTL stays as the backstop for a process that dies mid-turn.

## Contract

| surface | scope | guard | on trip |
| --- | --- | --- | --- |
| `/v1/messages`, `/v1/responses`, `/v1/chat/completions` | conversation key | G1 scope churn | HTTP **429**, `retry-after: 60`, message names the scope and the counts |
| `/api/v1/acp` (brokered transport) | client session id | G1 scope churn | JSON-RPC error (`-32000`), message names the scope and the counts |
| every ACP turn (`pumpTurn`) | — | G3 stall | `JudgeUnavailable` — the turn ends, the caller gets a definite answer |
| every pooled peer | spawn label | G2 peer breaker | the child is killed; the request fails loudly; the next request respawns |

### Config (`serve` section)

| key | type | default | meaning |
| --- | --- | --- | --- |
| `serve.acpMaxOpens` | int ≥ 1 | `8` | sessions opened and not completed, per scope, before G1 trips |
| `serve.acpMaxAbandoned` | int ≥ 1 | `32` | sessions opened and not completed, per peer, before G2 breaks the peer |
| `serve.acpStallMs` | int ≥ 0 | `300000` | silence bound per turn; `0` disables G3 |

The env pins `BRO_PROVIDER_ACP_MAX_OPENS`, `BRO_PROVIDER_ACP_MAX_ABANDONED`
and `BRO_PROVIDER_ACP_STALL_MS` override the file, next to
`BRO_PROVIDER_TIMEOUT_MS`.

## Tests

- G1: a scope that opens `maxOpens + 1` sessions without a completion trips
  the guard; the refusal throws `AcpDeadLoopError` **before** any session is
  opened (the fake agent records no new session).
- G1: a tripped scope is refused for the cooldown, then exactly one probe is
  allowed through (half-open), and the probe's completion clears the trip.
- G1: a completed turn resets the difference — a conversation that answers
  never trips, however many turns it takes.
- G1: a tripped scope is refused for the cooldown, then a probe is allowed
  through (half-open), and a success clears the trip.
- G2: a peer's abandoned opens over the budget mark the peer for breaking;
  the pool kills the child and the next link respawns.
- G3: a turn that produces no update is ended by the stall watchdog with the
  stall named; a turn that updates regularly is never touched by it.
- G4: a failed turn releases the session-cap claim (the next turn is not
  refused by the cap).
- The conductor maps `AcpDeadLoopError` to 429 + `retry-after`; the brokered
  transport maps it to a JSON-RPC error.

## Out of scope

- **The agent's own churn inside the child** (Devin's skills discovery,
  its per-session setup). bro cannot teach a vendor's CLI to scan less;
  G1 stops bro from *paying* for it and G2 stops the child from surviving
  it.
- **Retrying the client's turn.** bro does not retry a turn; the guard
  refuses the churn, it does not paper over it.
- **The idle release** — the peer that is alive but idle is a different
  failure mode with its own spec (`bro-7ira8`).
- **The per-account quota itself.** bro can stop being a standing consumer;
  it cannot change what the operator's own session spends.
