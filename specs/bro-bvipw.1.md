# bro-bvipw.1 — anthropic surface gaps: tool_choice, stop_sequences, error taxonomy, keepalive

## Problem

The conductor answered the happy path but shrugged on four surface
areas claude code actually sends:

- `tool_choice` was ignored — `any`/`tool`/`none` had no effect on
  the `<tools>` contract, so a forced call arrived unforced and a
  forbidden call arrived documented.
- `stop_sequences` was ignored — markers streamed to the client
  verbatim and `stop_reason` never reported `stop_sequence`.
- Failures classified only as 529-or-500: a quota wall wore the same
  shape as an outage, so client retry logic could not tell
  "back off on a schedule" from "the listener is dead".
- A held acp turn emitted nothing for its whole duration — claude's
  read timeout treats silence as a dead stream; the wire's own
  answer is `ping` events.

## Fix

- `MessagesRequest` accepts `tool_choice`/`stop_sequences`;
  `toolContract` appends the must-call line for `any`/`tool`
  (`You MUST call the tool "<name>".`), and `prefixText` withholds
  the whole contract on `none`.
- `StopFilter` — the incremental marker cut. `feed()` holds back the
  longest suffix that still prefixes a sequence (same mechanics as
  `<tool_call>` tag splitting); a hit returns pre-marker text once
  and swallows the rest. `LiveTurn` feeds per-delta; the buffered
  leg cuts `reply.text` before `parseReply`, so both paths record
  the reply the client actually saw. `stop_reason: stop_sequence` +
  `stop_sequence: <marker>` land in `message_delta`, the buffered
  body, and the recorded `lastReply` replay.
- `turnError` adds the `RATE` class: `/rate.?limit|too many|quota|429/i`
  → 429 `rate_limit_error` + `Retry-After: 30` (in-stream the same
  type on the `error` event). 529 `overloaded_error` and 500
  `api_error` unchanged.
- `messages()` validates `messages` is a non-empty array of
  `{role: user|assistant, content: string|blocks}` — 400
  `invalid_request_error`, not a 500 downstream.
- `ConductorConfig.keepaliveMs` (env `BRO_CONDUCTOR_KEEPALIVE_MS`,
  default 10s): `LiveTurn` ticks `event: ping` while the stream is
  open, cleared on `finish()`/`error()`.
- testkit: `failPrompt: 'rate-limit'` (RequestError so the wording
  survives the acp envelope).

No `thinking`, `cache_control`, `max_tokens`, or temperature-family
work — ACP has no knobs; they remain accepted no-ops per
specs/bro-bvipw.md.

## Verify

- `serve-conductor.test.ts` gains the `tool_choice, stop_sequences,
  error taxonomy, keepalive` describe: contract steering (auto/any/
  tool/none), split-marker stream cut, buffered cut + stop_sequence,
  absent-marker tail flush, 400 on empty messages, 429+Retry-After,
  ping cadence on a held turn — 10 tests, whole file green.
