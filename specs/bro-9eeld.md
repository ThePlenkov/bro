---

parent: bro-7xgk
scope:
- packages/core/src/agents.ts
- packages/cli/src/agent-connectors.ts

---

# bro-9eeld — loop chases a MOVING rate-limit deadline — spawns land in an already-locked provider state (instant-death churn extends the wall)

## Problem

Observed 2026-10-27 — three instant-death rounds in a row: a spawn died
14s after a reset boundary, the block lifted at the LAST message's
deadline, and the respawn (native-1d00e1b4, spawned 18:05:33) died 11s
later on `-32010 … reset at 19:01 UTC`. The recorded deadline ladder
walked 04:10 → 08:59 → 09:59 → 10:59 → 13:59 → 16:59 → 18:04 → 18:59 →
19:01 — every re-hit cost a fresh spawn + inference burn against the same
wall (drill 9f3c71, verified against `loop.out`):

- **A — multi-unit truncation.** `relReset` captures ONE number+unit
  pair; "resets in 1 hour 55 minutes" parses as +1h. Wall 18:04:50 =
  classify-time +1h exactly while the quote said 1h55m to 19:01 UTC.
- **B — relative beats the clock mark.** `parseResetAt` tries `relReset`
  first and has no extractor for the provider's `(at HH:MM UTC)` form;
  classify+54m = 18:59:54 vs the true mark 19:01 — the loop unblocks
  ~66s EARLY every cycle and spawns into a closed door.
- **C — no instant-death backoff.** A spawn→exit <60s `rate_limited`
  death re-blocks only until the same undershot mark, so consecutive
  churn rounds each land inside the still-locked window.

Disproven by the drill (do NOT build on it): "each re-hit pushes the
provider deadline" — quoted marks are FIXED within an episode
(19:01→19:01 across a churn). The ladder drift was defects A+B plus
genuine hourly budget re-burn.

## Design

### Reset parsing (`packages/core/src/agents.ts`)

- `relReset` sums EVERY number+unit pair in the duration phrase — "in 1
  hour 55 minutes" → +115m, "in 1h 30m" → +90m. `retry-after: N` stays
  bare seconds (a protocol value, not fuzzy prose).
- New `clockReset` extractor for the quoted clock mark — `at
  HH:MM(:SS)?` with optional `UTC`/`GMT`/`Z` zone (absent → UTC; bro
  stamps UTC everywhere). It runs FIRST in `parseResetAt`: the clock
  mark is authoritative over the same message's "in N minutes"
  paraphrase. A mark followed by a `YYYY-MM-DD` date is left to
  `isoReset` (already exact).
- Day-ambiguous marks resolve to the NEARER of today's/tomorrow's
  occurrence at `now`: a mark already past reads as the lifted wall —
  lazy classification can read the tail hours after the death it stamps,
  and rolling a stale quote +24h would fabricate a day-long block.
- Fuzzy forms get a safety margin — the observed early-unblock skew was
  ~66-90s between the parsed deadline and a live spawn: clock marks and
  relative phrases resolve +`RESET_MARK_MARGIN_MS` (90s). Protocol-exact
  forms (`retry-after`, HTTP-date, ISO, epoch) carry no margin.
- `ensureExitCause` classifies against the `.exit` file's mtime (the
  honest death stamp) instead of the read-time clock — a lazy read hours
  after the death must not re-anchor "in 54 minutes" to now.

### Instant-death backoff

A `rate_limited` death inside `INSTANT_DEATH_MS` (60s) of `spawnedAt`
proves the recorded mark undershot — no real work could have happened.
The registry entry gains `rateStreak`, the count of consecutive instant
rate deaths: every other classified outcome resets it (a slow death did
real work), and it survives respawns through the registry merge — the
streak is a property of the step's wall history, not of one run.

`rateDeathBackoff(entry, cause, resetAt, exitAt)` in core returns the
next streak and the reset the entry should carry: an instant death makes
the hold end `max(reported, exitAt) + min(30s · 2^(streak-1), 30m)` —
the wait added over the provider's word doubles per consecutive instant
death (30s, 60s, 120s…). A stale/absent reported mark escalates from the
death itself, and no reported reset stays indefinite — the `bro agents
down` escape is that wall's contract.

`ensureExitCause` stamps the escalated `resetAt` and `rateStreak` — one
write covers every consumer unchanged: `agentEntryBlocked` (per-step
respawn guard), `deriveProviderWalls`/`batchWallRefusal` (the batch-lane
wall the loop polls), `blockedDecision` (convoy waits), and
`blockedRespawnDetail` (refusal text).

Out of scope: re-querying the provider before spawn (there is no such
API — the log message IS the provider's word), and the pacing half —
[#685](https://github.com/ThePlenkov/bro/pull/685)'s lane gate / wall
pauses complement but don't overlap.

## Plan

- [ ] `agents.ts` — `clockReset` extractor first in `parseResetAt`,
  multi-unit `relReset`, `RESET_MARK_MARGIN_MS`, `INSTANT_DEATH_MS` +
  `rateDeathBackoff` (streak-scaled hold)
- [ ] `agent-connectors.ts` — `ensureExitCause` classifies at the `.exit`
  mtime, stamps escalated `resetAt` + `rateStreak` in the same write
- [ ] `agents.test.ts` — multi-unit sums, clock-mark precedence and
  day-ambiguous resolution, margin, `rateDeathBackoff` streak math
- [ ] `agent-connectors.test.ts` — `.exit` mtime near `spawnedAt`
  records an escalated `resetAt` + `rateStreak`; the second
  consecutive instant death doubles the added wait
- [ ] `npm run build`, `npm run typecheck`, `npm test` (exact CI command)
