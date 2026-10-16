# bro-728wl — conductor: stream acp turn live

## Problem

`POST /v1/messages` with `stream: true` (default) buffers the whole acp
turn before answering: `messages()` awaits `acpPooledTurn` to
completion, THEN writes SSE headers, THEN `emitBlocks` dumps every
event in one burst. A client sees silence for the entire turn — the
"frozen, then everything at once" symptom — even though the acp
provider has streamed `session/update` deltas since bro-d6mcd (#555).

## Fix

In `serve-conductor.ts`, when `body.stream !== false`:

1. Emit `message_start` as soon as the turn begins — `res.writeHead(200,
   text/event-stream)` + the start event fire before the first delta,
   never after the turn resolves. The `model` field carries the pinned
   model (`opts.model ?? cfg.model ?? requested id`) — provenance of
   what was asked; the agent-reported model still lands in otel.
2. Pass `onUpdate` into `acpPooledTurn` (the `PooledTurnOpts.onUpdate`
   seam exists). Route each `agent_message_chunk` text delta through an
   incremental parser that splits text vs `<tool_call>…</tool_call>`
   spans — the same contract `parseReply` applies to the full text.
   - Text outside a tool_call emits `content_block_delta` (text_delta)
     as it arrives, inside one open text block.
   - A completed `<tool_call>` closes the open text block, then emits
     `content_block_start` + `input_json_delta` + `content_block_stop`
     for a `tool_use` block at the next index. Unparseable JSON stays
     raw text — the wire never invents a call (parseReply's rule).
   - A partial tag spanning deltas is held back until `</tool_call>`
     arrives or the turn ends (an unclosed tag emits as raw text).
   - `tool_call`/`tool_call_update` session updates and other update
     kinds are ignored for SSE output — the text channel is the
     conductor's contract (the agent emits tool calls as markup text).
3. On turn end: `message_delta` (mapped stop_reason, `tool_use` when a
   tool_use block was emitted) + `message_stop`, then `res.end()`.
4. A turn error after headers are sent emits an SSE `error` event then
   closes — status codes are no longer available once streaming began.

Non-stream path (`stream: false`) is unchanged: full turn, JSON body.

## Out of scope

- `terminal/*` client capability, host-side task cards (bro-z7afs).
- Native acp `tool_call` updates → anthropic tool_use blocks (the
  conductor's tool contract is text-markup; native updates are a
  different surface).

## Tests

- Fake peer (`opts.acp.peer` seam) streaming text deltas: SSE events
  arrive interleaved — `message_start` and first `content_block_delta`
  before the turn resolves (assert event ordering vs. turn completion).
- Delta-split `<tool_call>`: tag split across chunk boundaries parses
  to one tool_use block; surrounding text keeps order.
- Malformed `<tool_call>` JSON → emitted as text, no invented call.
- `stream: false` unchanged.
- Mid-turn failure → SSE `error` event, not a hanging response.
