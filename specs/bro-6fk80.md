# bro-6fk80 — conductor: honest stop_reason for cancelled + non-enum acp reasons

## Problem

`serve-conductor.ts` `STOP_REASON` maps acp `stopReason` onto the
Anthropic enum and swallows everything else:

- `cancelled: 'end_turn'` — a cancelled turn reads as a clean finish.
- `?? 'end_turn'` fallback — adapter reasons outside the acp enum
  (Devin can emit `error` / `auth_required`) report as a clean finish.

A cancelled or backend-ended turn is indistinguishable from a real
`end_turn` on every surface: the `message_delta` stop_reason, the
recorded `lastReply` (and every replay of it), the Responses `status`,
the chat `finish_reason`, and otel. A client polling a cancelled turn
learns "done"; an operator tracing a quota/auth wall sees nothing.

## Fix

One canonicalizer — `canonicalStopReason(raw)` — owns the mapping for
all four call sites (streamed + buffered /v1/messages, /v1/responses,
/v1/chat/completions):

- Known acp reasons keep their mappings (`end_turn`, `max_tokens`,
  `max_turn_requests` → `pause_turn`, `refusal`).
- `cancelled` maps to the non-standard stop_reason `'cancelled'` — a
  client-visible marker the enum can't carry; clients can branch on it.
- Any other non-empty unmapped reason forwards **raw** (`'error'`,
  `'auth_required'`, newer acp values) — never `'end_turn'` — plus one
  `otelEvent('conductor.stop_reason.unmapped', { reason })` per turn so
  the anomaly is observable server-side.
- Missing/empty reason still falls back to `'end_turn'` (no signal to
  forward).

Per-dialect surfacing of the canonical reason:

- **/v1/messages** — `message_delta.delta.stop_reason` carries it
  verbatim (`'cancelled'`, `'error'`, …). Anthropic SDKs pass unknown
  stop_reason strings through; strict-SDK rejection is not a risk the
  wire takes here.
- **/v1/responses** — `respStatus` maps canonical reasons onto real
  Response statuses: clean reasons → `completed`, `max_tokens` →
  `incomplete`, `cancelled` → `cancelled`, anything unmapped →
  `failed`. A `failed` envelope carries `error: { code: 'server_error',
  message }` naming the raw reason — `error: null` on a failed
  response would be its own lie.
- **/v1/chat/completions** — `finish_reason` keeps `CHAT_FINISH` for
  the mapped set; an unmapped canonical reason forwards raw
  (`'cancelled'`, `'error'`) instead of the silent `'stop'` fallback —
  the enum has no honest value, so the marker travels.

`stop_sequence`/`tool_use`/`cap` precedence is unchanged — a real
tool_use or stop hit still outranks the transport reason. Replays
report the recorded (canonical) reason, so a cancelled turn replays as
`cancelled`.

## Out of scope

- Emitting an SSE `error` event in place of the normal turn epilogue —
  the bead allows either form; the non-standard stop_reason/status is
  the lighter marker and survives record/replay uniformly.
- Changing what the acp layer emits — `pumpTurn`/`PooledReply` already
  forward `msg.stopReason` raw; the conductor was the swallowing point.

## Tests

- Streamed /v1/messages with `stopReason: 'cancelled'` →
  `message_delta` stop_reason `'cancelled'` (not `'end_turn'`).
- Buffered /v1/messages with `stopReason: 'error'` (non-enum) →
  `stop_reason 'error'` in the JSON body; a second (replay) send of the
  same conversation reports `'error'` too.
- /v1/responses with `stopReason: 'cancelled'` → `status: 'cancelled'`;
  with a non-enum reason → `status: 'failed'` and `error.message`
  naming the reason.
- /v1/chat/completions with `stopReason: 'cancelled'` →
  `finish_reason: 'cancelled'`.
- Known reasons unchanged: `max_tokens` → `max_tokens`/`incomplete`/
  `length` as today.
