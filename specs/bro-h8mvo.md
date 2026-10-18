# bro-h8mvo — conductor: narrate agent tool_call lifecycle into the SSE text stream

## Problem

`LiveTurn.onUpdate` (serve-conductor.ts) forwards only
`agent_message_chunk` text deltas. Every other session/update —
`tool_call`, `tool_call_update`, `subagent_update` — is dropped. That
was a deliberate carve-out in spec bro-728wl ("the text channel is the
conductor's contract"), but it hides *agent-side* work: an acp agent's
own tools (exec, file ops, subagent spawns) run inside the agent and
are reported ONLY through these updates. The client sees the text that
surrounds them and nothing between — a long run of tool work looks
like a frozen turn, then a burst of prose. Owner report 2026-10-18:
"in claude I do not see background tasks at all — the agent looks
stuck then done".

## Fix

Extend `LiveTurn.onUpdate` to narrate the `tool_call` lifecycle as
text deltas — start on `tool_call`, a check/cross on the first
terminal `tool_call_update` (`completed`/`failed`, deduped by
toolCallId):

- start: `\n⏺ <title>\n`
- end: `\n✓ <title>\n` / `\n✗ <title>\n`

Label: `title ?? name ?? kind`, first line only, capped ~120 chars —
titles can carry whole command strings.

The narration is TEXT, not `tool_use`: the tool already ran inside the
agent — a tool_use block would ask the client to execute it a second
time. The text channel stays the conductor's contract; this fills its
blind spot rather than changing the contract.

In-scope edges only: `tool_call` + terminal `tool_call_update`.
Content/plan/usage/subagent updates stay ignored (chatter, not
lifecycle) — revisit if a real surface needs them.

Live-only signal: narration lines are emitted through the live text
stream and never enter `reply.text`, so a replayed/settled turn shows
the content without synthetic activity lines (the settled answer stays
the agent's own words).

## Verify

- `fakeAcpAgent` emitting `tool_call` + `tool_call_update` between
  text chunks → SSE carries `⏺ <title>` and `✓ <title>` text_deltas in
  order, and `stop_reason` is unaffected by narration (no tool_use
  invented — `sawTool` must not flip on narration).
- A second terminal update for the same toolCallId emits nothing
  (dedupe).
- `tool_call_update` with non-terminal status emits nothing.
