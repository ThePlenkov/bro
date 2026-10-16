# bro-7izjx — image content blocks on the acp bridge

Deferred from PR #553 (thread `PRRT_kwDOUamqtM6tGZZH`): `blockText()`
collapsed every non-text inbound block to a `[${type}]` marker, so a
Claude-compatible `/v1/messages` request carrying image blocks reached
the agent as the literal string `[image]` — the model never saw the
picture.

## Change

- `acpInit` reads `init.agentCapabilities.promptCapabilities.image`
  and returns `caps` — plumbed onto `AcpPeer` (`peer.caps.image`).
- `session.prompt` already accepts `ContentBlock[]`; `pumpTurn` and
  `acpPooledTurn` widen `promptText: string` →
  `prompt: string | ContentBlock[]` (string callers untouched).
- `serializeBlocks(body, imageOk)` replaces `serializeRequest` at the
  conductor call site: identical transcript, but a base64
  `{type:'image', source:{media_type,data}}` inbound block becomes a
  real ACP `{type:'image', data, mimeType}` block in-place inside its
  `<turn>` wrapper. url/file sources and agents without the
  capability degrade to the `[image]` marker exactly as before —
  honest degradation, never a wire block the agent can't read.
- `link()` now runs before serialization so the negotiated caps are
  known; `inputTokens` counts text blocks only (base64 is not tokens).

## Non-goals

- No fetching of url-sourced images into base64 — that is a client
  concern; the marker keeps the turn honest.
- One-shot `acpOp`/`acpConverse` keep string prompts — the conductor
  is the only surface that receives rich inbound content today.

## Verify

- Fake-agent e2e: `imageCapable` agent receives the image block
  verbatim; a non-capable agent gets one text block with `[image]`.
