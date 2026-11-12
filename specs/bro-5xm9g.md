# bro-5xm9g — serve probe/live-check traffic pays a fresh ACP session per turn on a shared quota lane

## Problem

On 2026-11-07 the account hit the Devin free-model rate wall. The retro
(`retro:2026-11-07-devin-lock`) traced part of the burn to **probe
traffic**, not user work:

- `.git/bro/serve-turns.jsonl` shows `conductor.turn
  backend=devin-acp model=adaptive session_reused:false
  input_tokens≈11068` per probe turn — `GET /v1/models` +
  `POST /v1/messages` pairs every ~16 min;
- sessions.db gained **41 short `bro-live-check/echo` sessions** in 11 h
  (2026-11-06T14:21Z → 2026-11-07T01:42Z) — the
  `scripts/claude-code-live-check.ts` cadence, each run a fresh ACP
  `session/new` plus a ~11k-token prompt (the client's whole
  system+tools prefix);
- Devin quota is **account-wide**: probe churn spends the same budget
  interactive and batch work needs.

PR #977 shipped the first slice — named (`h:`) sessions outlive the
anonymous 10 min TTL (a ~16 min probe cadence vs 10 min TTL meant every
probe missed reuse), and `conductor.turn` gained `session_key_ns` so the
burn is attributable. What remains: probe traffic is still **keyless or
fingerprint-keyed**, so every probe either takes `oneShotTurn` (fresh
session, disposed) or misses the conversation proofs and pays
`session/new` again — and nothing tells the conductor a request IS a
probe, so it cannot reuse, gate, or label it.

## Audit — who spends it

| surface | path | cost today |
| --- | --- | --- |
| `POST /v1/messages` probes | `messages()` → `acpTurn` → `freshTurn`/`oneShotTurn` | `session/new` + full ~11k prompt per probe; fingerprint TTL < cadence → every probe fresh |
| `GET /v1/models` | `models()` → `laneCatalog` → `catalogModels` → `acpModels` → `withAcp` | **fresh `devin acp` child + initialize + `session/new` per lane per read** (28–52 s observed) — no prompt tokens, but a session slot and a skills-rescan child per read |
| `GET /api/v1/health` | serve.ts JSON | none — already cheap |
| `POST /v1/messages/count_tokens` | heuristic estimate | none — already cheap |

Real user/conductor turns share the same `acpTurn` path — the fix must
classify probe traffic explicitly and leave every other turn untouched.

## Design

### `x-bro-probe` — the probe marker

A request carrying `x-bro-probe` is probe traffic. The header's value is
an optional label (`live-check`, `health`, …; absent/empty → `probe`),
kept for telemetry only — the session key is per-lane, not per-label.
Clients that can set headers opt in: claude-code via
`ANTHROPIC_CUSTOM_HEADERS` (the live-check script sets
`x-bro-probe: live-check`).

`x-bro-session` is NOT the marker — it pins a *conversation*; probe-ness
is a traffic class. A client that wants a persistent named session keeps
using `x-bro-session` and gets conversation semantics, not probe ones.

### One warm probe session per lane

Probe requests route to a dedicated `ConvSession` keyed
`probe:<lane.entry>` — ONE retained ACP session per provider lane,
shared by every probe on it (the work order's per-lane key). It rides
the existing reuse machinery with two deliberate differences:

- **no conversation proofs** — probes are independent liveness turns,
  not continuations. Each probe turn sends its FULL serialized body
  (`serializeBlocks`, same as `freshTurn`) on the retained session;
  `consumed`/`historyHash`/replay do not apply. A warm probe pays the
  prompt but skips `session/new` and the agent's context re-ingest —
  the ~11k-per-probe burn becomes prompt-size on an already-open
  session.
- **named TTL** — `probe:` keys get `CONV_TTL_NAMED_MS` (60 min) in
  `sweepSessions`, so the session survives the ~16 min probe cadence;
  `CONV_CAP` and the idle release still bound it.

Context accumulates across probes on the shared session (each full body
lands in context). That is the price of skipping `session/new`; it is
bounded by the 60 min TTL — a lane serving ~4 probes/hour accumulates
~12 turns per session-life, inside the agent's own compaction range —
and self-heals: a session that dies or answers garbage is evicted and
the next probe opens fresh.

### Wall gate — a walled lane skips the probe entirely

Before `wire.link()` (which would spawn the pooled peer), a probe
request checks `lane.cooldown.refusal()`. A walled lane refuses the
probe with the cooldown's own 429 + `retry-after` — no peer spawn, no
cap claim, no `session/new`. Real turns keep the existing
refuse-at-session-open behavior; only probes take the early exit,
because a probe's whole job is to measure the lane — a lane that
already said no has nothing to measure.

### Telemetry — probe burn is attributable

`conductor.turn` gains `probe: true` and `probe_label: <label>` on every
probe turn (including the wall-skipped refusal, journaled with
`skipped: 'wall'` and zero tokens — the skip IS the observation).
`session_key_ns` reports `probe` for `probe:` keys, splitting probe
sessions from `named`/`fingerprint`/`none` in the serve-turns ledger.

### `GET /v1/models` — catalog cache per lane

`laneCatalog` caches each lane's successful catalog rows for
`CATALOG_TTL_MS` (60 s) on the `ProviderLane`. Repeated reads inside the
window — a client's startup burst, back-to-back live-check invocations
— collapse to one `session/new`; failures are never cached, so a lane
that recovers is re-read on the next request. The catalog is live data
(agent `configOptions`), so the TTL is deliberately short: it kills the
burst, not the freshness.

## Contract

| surface | before | after |
| --- | --- | --- |
| `POST /v1/messages` + `x-bro-probe` | keyless/fingerprint → fresh session per probe | `probe:<lane>` retained session; warm probes `session_reused:true`, `probe:true` |
| probe on a walled lane | session-open refusal after peer spawn | 429 before `wire.link` — zero session, zero spawn |
| `GET /v1/models` | `session/new` + child spawn per lane per read | per-lane 60 s success cache |
| every other turn | unchanged | unchanged |

## Tests

- a probe-marked request opens ONE session; a second probe (different
  body) reuses it — `session_reused:true`, `probe:true`,
  `session_key_ns:'probe'` in the journal, `fake.sessions.length === 1`;
- two probes on different lanes get different `probe:<entry>` sessions;
- a probe on a walled lane answers 429 with `retry-after` and opens no
  session (`fake.sessions.length === 0`, no link);
- `sweepSessions` keeps a `probe:` session past the 10 min anonymous
  TTL out to the named TTL;
- `keyNs('probe:x') === 'probe'`;
- `GET /v1/models` twice inside the TTL costs one catalog read
  (`fake.sessions.length === 1` across both);
- the live-check script's client env carries `x-bro-probe`.

## Out of scope

- **Real turns' reuse semantics** — conversations, chaining, replay,
  and the fingerprint proofs are untouched; probe traffic is the only
  new class.
- **`/v1/responses` and `/v1/chat/completions` probe marking** — the
  dialects share `acpTurn` but only `/v1/messages` honors the header
  today; codex-shaped probes are not the observed burn.
- **A no-inference probe endpoint** — `GET /api/v1/health` already
  answers cheaply; nothing here needs a canned model reply.
- **Catalog TTL configurability** — 60 s is an internal bound; a knob
  is a follow-up if an operator needs it.
