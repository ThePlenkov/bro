# bro-zkpju — gateway multi-dialect: OpenAI /v1/responses + /v1/chat/completions

Epic: `bro-bvipw` (full client support: claude + codex through the gateway).

## Problem

The conductor plane speaks one dialect — anthropic `/v1/messages`. Codex
(and every OpenAI-shaped client) cannot use the gateway, so `bro` can
drive only claude as a dogfood/fleet client.

## Design

The canonical seam already exists:

```text
request → serialized transcript → acp turn → content blocks
```

A dialect is an ingress parser + an egress renderer over that seam.
The `<tool_call>` emulation, the retained-session machinery, model
pins, tool contracts, and error taxonomy are dialect-agnostic and are
reused unchanged.

### /v1/responses (codex's wire)

- Ingress: `input` (string or items) → canonical messages;
  `message`/`function_call`/`function_call_output` items map to
  text/`tool_use`/`tool_result` blocks so history replays verbatim;
  `instructions` → the system prefix; `tools`/`tool_choice` → the
  canonical contract; `reasoning.effort` folds into the composite
  model pin (`base-effort` → model + thought_level leaf).
- Continuity: `previous_response_id` resolves through a chain ledger
  (response id → conv key). Chained turns are **delta semantics** —
  the session holds the history, so the fingerprint proof is skipped
  (`TurnEnv.chained`); `settleConv` accumulates `consumed` and clears
  `historyHash` so a later full-resend can never falsely prove the
  session (evict + fresh, never invent).
- Egress: buffered `response` object, or item-ordered SSE
  (`response.created` → `output_item`/`content_part`/`output_text.delta`
  → `function_call` items → `response.completed`).

### /v1/chat/completions (stateless chat wire)

- Stateless by contract — the client resends full history, so the
  fingerprint path retains/replays unmodified.
- Ingress: `system`/`developer` → system; `assistant.tool_calls` →
  `tool_use`; `role:"tool"` → `tool_result`; `image_url` data URLs →
  image blocks; `reasoning_effort` → composite pin.
- Egress: `chat.completion` object, or `chat.completion.chunk` deltas
  (`choices[0].delta`) ending in `[DONE]`; `stream_options.include_usage`
  emits the trailing usage chunk.

### Error envelope

OpenAI `{error:{message,type,param,code}}`; the conductor's taxonomy
maps RATE → 429 + `Retry-After` + `rate_limit_error` (checked before
AVAIL — a wrapped "unavailable — rate limit …" is a quota wall, not an
outage), AVAIL → 503, generic → 500, all `server_error` unless rate.

## Test tree (this PR — hermetic dialect suite)

`serve-conductor-openai.test.ts`: buffered/stream both dialects,
function-call round-trip, instructions/system serialization,
reasoning→pin fold, `previous_response_id` chain (one session, delta
only), fingerprint replay (chat), 400 validation, 429 + Retry-After.

Real-client proof (codex run) lands in `bro-bvipw.2`/`.3`.
