# bro-bvipw.4 — serve-conductor: accept claude 2.1.309's `role:'system'` turn

## Problem

Claude Code 2.1.309 stopped keeping its whole context in the top-level
`system` field. The environment block now rides INSIDE `messages`, as a
turn whose role is `system`:

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<system-reminder>…" },
        { "type": "text", "text": "ping" }
      ]
    },
    {
      "role": "system",
      "content": [
        { "type": "text", "text": "# Environment\n…" },
        { "type": "tool_addition", "tool": { "type": "tool_reference", "name": "advisor" } }
      ]
    }
  ]
}
```

The conductor's messages-shape gate accepted `user|assistant` only, so
EVERY turn of a current claude-code died before any provider work:

```text
API Error: 400 messages: a non-empty array of {role: user|assistant, content} turns is required
```

The 400 is backend-independent — the serve journal shows the same 400 on
the `opencode-iceman` AND the `devin-acp` backend. It is the gate, not
the model.

The dialects already knew the answer: the chat and responses paths
claim `system`/`developer` roles for the SYSTEM SLOT (`chatToBody`,
`responsesToBody` — "never a downgraded user turn"). The messages
dialect was the only one missing that claim.

## Fix

- The gate accepts `role:'system'`; the shape error names it.
- `liftSystemTurns` moves such a turn out of the conversation: its text
  becomes its own `<system>` block in the prompt (`prefixText`), so the
  transcript keeps the documented shape — `<system>` block, tool
  contract, then `<turn role="user|assistant">` segments.
- A turn's non-text blocks keep the `blockText` marker (`[tool_addition]`)
  — nothing is silently dropped.
- A request whose turns are ALL system still answers 400: a
  conversation needs a user turn to answer.
- The lifted turns come from the MESSAGES only — `systemTurns` is the
  conductor's own field, never one the wire may dictate. Every system
  turn leaves the conversation, even an empty one: a turn that stayed
  would ride the transcript as a user turn.
- The lifted text lives in the prefix, so the conversation-fingerprint
  proof covers it — a changed environment context selects a NEW
  fingerprinted session; the previous retained session is reclaimed by
  the normal TTL/cap sweep instead of answering under stale
  instructions.

## Verify

- `serve-conductor.test.ts` gains four cases: a `role:'system'` turn
  lands in a `<system>` block and never in a user turn; a non-text
  block keeps its marker; a system-only request answers 400; an
  unknown role still answers 400.
- Real claude-code 2.1.309 against the conductor: before the fix
  `API Error: 400 messages: a non-empty array of {role: user|assistant,
  content} turns is required`, after it the turn answers.
