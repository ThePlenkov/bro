# bro-5nvwi — serve-conductor rejects non-text parts in role:tool messages

## Problem

Deferred from PR #589 (fix-round cap). In the /v1/chat/completions
dialect, `chatToMessages` folded every `chatContent` block of a
`role:'tool'` message to text-or-`''` — a data-URL `image_url` part
parsed fine through `chatContent` into an `image` InBlock, then was
silently mapped to `''` on the way into the `tool_result` content. The
agent would "answer" about a tool result whose payload it never
received — the exact failure mode the same file already rejects for
system/developer messages (`'system/developer messages support text
content only'`) and for unknown content parts anywhere else
(`'unsupported content part type: …'`).

## Design

The contract is one rule applied uniformly: content the wire accepted
but the agent cannot see is a 400-class translation error, never a
silent drop.

- `chatToMessages` tool branch: after `chatContent(m.content)` maps the
  parts, the join over blocks keeps `text` verbatim and throws
  `Error('tool messages support text content only')` on anything else —
  the same shape as the system/developer gate in `chatToBody`, so the
  refusal lands as `invalid_request_error` before any turn is paid for.
- A `role:'tool'` message whose content is a plain string is untouched
  (no `chatContent` pass), and array content of pure text parts still
  joins into the `tool_result` payload.
- Ordering note: an `image_url` part with a *remote* URL still throws
  `'image_url: only data: URLs are supported'` inside `chatContent`
  before the tool-tier map runs — the tool-tier guard only sees parts
  that parsed successfully.

**Implementation state:** the guard itself landed on main via PR #928
(commit `83c3bb4b`, `Refs: bro-5nvwi`) while this bead waited in the
deferred queue. What remained — and what this change ships — is the
coverage the bead asks for: the rejection, the join, and the
system-tier parity pin.

## Tests

`packages/cli/src/commands/serve-conductor-openai.test.ts`:

- a `role:'tool'` message carrying a data-URL `image_url` part answers
  400 with `tool messages support text content only` — and no prompt
  reaches the agent (no turn was paid for);
- a `role:'tool'` message with array content of text parts still joins
  into `<tool_result for="…">…` verbatim;
- parity: a `system` message carrying the same data-URL `image_url`
  part answers 400 with `system/developer messages support text
  content only` — both tiers refuse the same way.
