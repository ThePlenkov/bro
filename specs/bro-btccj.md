# bro-btccj — conductor: forward agent tool activity as structured SSE events

## Problem

`LiveTurn.onUpdate` (serve-conductor.ts) turns an acp agent's native
`tool_call`/`tool_call_update` session updates into *text* narration
(spec bro-h8mvo): `⏺ <title>` / `✓ <title>` / `✗ <title>` deltas inside
the text stream. That fixed the "frozen turn" report for clients that
render prose — but the activity is locked inside the text channel.
A client that wants structure (a tool pane, a spinner keyed by
toolCallId, a terminal link) must re-parse narration lines out of the
assistant's own words — fragile, lossy (no kind/status/terminalId), and
indistinguishable from text the model actually wrote.

The updates already arrive: `pumpTurn`'s `onUpdate` sink receives the
full lifecycle, and the 'agent' bus topic (bro-0ppt0) already
normalizes it to open/finish edges for internal consumers. The
conductor's client-facing SSE stream is the last surface still blind.

## Fix

Emit a named SSE event — `tool_activity` — on each tool lifecycle
edge, alongside (never instead of) the text narration:

```
event: tool_activity
data: {"type":"tool_activity","phase":"open","toolCallId":"tc-1","title":"exec: ls","kind":"execute","status":"in_progress"}
```

- Edge semantics are the bus's own (`acp-events.ts` `toolPayload`):
  `tool_call` → `open`; terminal `tool_call_update` and a repeated
  terminal `tool_call` → `finish`; a call first seen already-terminal
  emits open+finish in order. Mid-flight status churn stays off the
  wire — only edges cross. Fields present on the update pass through:
  `title`, `name`, `kind`, `status`, and `terminalId` lifted from
  `content[].type === 'terminal'` (the bro-eua0d pairing — events
  point at terminal registry ids once terminals exist).
- `LiveTurn`'s narration edge-deciders own emission so the structured
  event and the `⏺`/`✓` text edge always agree — same dedup, same
  labels, no second copy of the lifecycle to drift.
- The event is an envelope, not a content block: `toolCallId`
  correlates open→finish, `phase` is the edge. It rides beside
  `content_block_*` events and never touches block indices,
  `stop_reason`, or the recorded reply (`emittedBlocks` unchanged —
  activity is session metadata, not the agent's message).
- It is also NOT `tool_use`: the tool already ran inside the agent —
  a `tool_use` block would have a client execute it again or wait on
  a `tool_result` that never comes (the bead's MUST NOT).

Wire-format decision (the bead's options): **(b) named SSE event**.
(a) `server_tool_use` blocks promise Anthropic semantics we can't
honor — the real API restricts the name set and the client must still
handle result blocks; unknown block types risk strict-SDK rejection.
(c) text markers already shipped as h8mvo narration. A named event is
unambiguous for custom clients and ignored harmlessly by SDK parsers
that don't know it.

Client rendering notes (the docs deliverable): narration text renders
everywhere the text stream does — including back into the message
history if a client replays it (h8mvo keeps it out of `reply.text`,
so a settled/replayed turn stays clean). `tool_activity` renders only
in clients that read named SSE events — today that is bro's own
surfaces (webui/serve consumers); the Anthropic SDK drops unknown
events silently, which is the correct degrade for strict clients.

Scope: the Messages-API dialect (`LiveTurn`). The OpenAI dialects
(`RespLive`, `ChatLive`) have no tool narration at all — activity
events there are a separate bead if a real client needs them.

## Verify

- `fakeAcpAgent` emitting `tool_call` + `tool_call_update` for 3 tools
  between text chunks → SSE carries `tool_activity` open+finish events
  for each toolCallId, in update order, all before `message_stop`.
- A call first seen already-terminal emits open then finish (no
  orphaned finish).
- A duped terminal update emits no second finish; a non-terminal
  `tool_call_update` emits nothing.
- `terminalId` in tool content surfaces on the event payload.
- `stop_reason` is untouched by activity events (no tool_use invented)
  and the text narration still lands (`⏺`/`✓` assertions unchanged).
