# bro-whn25 — conductor session reuse: one acp session per client conversation

The `bro-xeozo` conductor opened a fresh acp session per `/v1/messages`
(`acpSessionOpen` + dispose inside `acpPooledTurn`), so every user
message paid the full serialized history + the agent's own session-start
rehydration as cold input tokens. Claude-shaped clients resend the whole
history on every call anyway — the conductor now keeps a retained acp
session per client conversation and feeds only the new tail.

## Change

- `acpSessionRetain(peer, entry, opts, deadline, turn)` in
  `packages/providers/src/acp.ts` — `session/new` once, model resolved
  at open, `prompt()` per subsequent turn on the same `sessionId`.
  A differing `requestModel` re-resolves against the live session's
  config options; a resubmitted id is a no-op (raw-vs-raw compare).
  Error surface matches `acpPooledTurn`: config errors stay config,
  everything else arrives as `JudgeUnavailable`. A failed prompt
  disposes the acp-side session itself — a session whose turn died has
  unknowable context.
- Conversation identity in `serve-conductor.ts`:
  `x-bro-session` header wins for clients that can pin it; otherwise a
  fingerprint `sha256(prefix + serTurn(messages[0]))` — the history's
  birth certificate, stable because clients prepend, never rewrite the
  start. The response echoes the key on `x-bro-session` so a
  fingerprint client can upgrade to a pin.
- Correctness never trusts the key: a candidate session re-proves the
  consumed prefix byte-for-byte (`hashTurns(msgs, consumed)`) before
  slicing the delta. An edited or shrunken history evicts the stale
  session and opens a fresh one — poisoned context is never reused.
- Delta slicing: `tailTurns` = messages past the consumed boundary
  minus assistant echoes (the session already holds its own replies).
  `tailBlocks` serializes the delta in the same `<turn role>` shape —
  minus the system/tools prefix the session saw on turn one.
- A resend carrying nothing new replays the recorded reply — zero agent
  round-trips for client retries.
- Lifecycle: sessions die with their transport (`dropSessions` on the
  peer abort listener — a respawned child can never inherit a stale
  handle), on turn failure, on stale-prefix eviction, on TTL
  (`CONV_TTL_MS` 10 min) and on map overflow (`CONV_CAP` 32) —
  `sweepSessions` disposes retired handles, never leaks them.
- A busy session (its own turn still in flight) is never double-fed —
  the request falls back to the one-shot `acpPooledTurn` path and
  nothing is stored under the key.
- Per-turn observability unchanged: `session_reused` attribute on
  `conductor.turn`, `acp.session.retain` span at open.

## Non-goals

- True persistent sessions for ACP-capable clients is `bro-ymbq1`
  (native transport) — this is the Messages-only mitigation; the two
  halves do not overlap.
- No cross-listener persistence — sessions live in the proxy process;
  a serve restart cold-starts, which the protocol tolerates (the
  client resends history and a fresh fingerprint opens).

## Verify

- `acp.test.ts`: two prompts ride one `session/new`, dispose ends it;
  a differing request model re-pins once and resubmission is a no-op;
  a failed turn disposes + surfaces `JudgeUnavailable`.
- `serve-conductor.test.ts`: three-turn conversation reuses one
  session and sends only deltas; an identical resend replays without a
  turn; distinct `x-bro-session` pins get distinct sessions; an edited
  prefix evicts and restarts with the full body; a mid-conversation
  model change re-pins the live session; a failed turn evicts so the
  retry opens fresh.
