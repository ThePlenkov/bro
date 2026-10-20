# bro-cfwc1 — conductor: recorded reply breaks when native tool narration interleaves an unfinished tool_call tag

## Problem

A streamed `/v1/messages` turn derives the recorded reply
(`conv.lastReply.blocks`, the resend/replay source) from
`parseReply(stops.emitted)` — a post-hoc re-parse of the flat text the
client saw. `LiveTurn.onUpdate` feeds TWO sources into that one text:

1. `agent_message_chunk` deltas — an unfinished `<tool_call>` can
   straddle chunk boundaries (the TagPump holds the partial tag in
   `pending`);
2. native `tool_call`/`tool_call_update` narration lines — emitted
   immediately as text edges.

When narration lands between the chunks of a split tag,
`stops.emitted` interleaves the narration INSIDE the unfinished markup.
The live wire is correct — the pump held the tag bytes and narration
went out as a plain text delta — but the recorded flat string is
`…<tool_call>{"name":\n⏺ exec\n"x",…}</tool_call>`: `JSON.parse` fails,
`toolCall()` returns undefined, the whole span stays raw text. A
resend/replay then answers broken markup instead of the tool_use — the
call the live client saw is lost (PR #588 review, deferred past
fix-round cap).

## Fix

Record the blocks actually emitted — `LiveTurn` already knows the
wire's true shape:

- `text(s)` appends to the currently open recorded text block (a new
  one opens when the previous emission was a tool_use), mirroring the
  SSE block boundaries.
- `call(name, input)` records `{type:'tool_use', id, name, input}`
  with the SAME `toolu_` id the wire emitted — replay fidelity, not
  the fresh id `parseReply` minted.
- The silent-turn parity block in `finish()` records `{type:'text',
  text:''}` so an empty reply keeps the buffered shape.

`messages()` takes `view.blocks` from `live.blocks` when a live turn
ran; the buffered leg still parses `stops.emitted` (it carries no
narration — narration is a live-pump feature). `ChatLive`/`RespLive`
don't narrate and stay on the re-parse. `stops` stays wired for the
hit gate and `stopSequence`/`divergent` bookkeeping.

## Test

Streamed turn — chunks `work <tool_ca`, a native `tool_call` update,
then `ll>{...}</tool_call> end`: the live stream emits the narration
as text plus a valid tool_use; an identical resend (replay) must emit
the tool_use block (`input_json_delta`), never the corrupted markup
as text.
