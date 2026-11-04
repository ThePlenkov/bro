# The Messages API ↔ ACP v2 mapping

What the bro gateway does with every field of the Anthropic Messages API
(`POST /v1/messages`, the beta surface) when the answer comes from an
ACP agent. Spec bro-9j4kt.

The gateway is a LiteLLM-shaped front door: it speaks the Anthropic
wire and drives an ACP agent behind it. The two protocols disagree
about almost everything, so this document is the contract: what maps,
what is approximated, what is ignored, and what the client is told
when a field cannot be honoured.

Sources:

- Anthropic: <https://platform.claude.com/docs/en/api/typescript/beta/messages/create>
- ACP v2: <https://agentclientprotocol.com/protocol/v2/overview>
  (the schema the SDK pins: `node_modules/@agentclientprotocol/sdk/schema/v2/schema.unstable.json`)

## The model

The Anthropic Messages API is **stateless**: the client resends the
whole conversation on every turn. ACP is **stateful**: a session
(`session/new`) holds the context, and a turn (`session/prompt`) adds
to it.

The gateway keeps one ACP session per conversation and feeds it only
the delta. Three things make that mapping work:

1. **The conversation identity** — the client says which conversation
   it means (`metadata.user_id`, the native signal; or `x-bro-session`,
   an explicit pin; or a fingerprint of the conversation's first turn).
2. **The birth certificate** — the session re-proves the conversation's
   FIRST turn before it continues. The later turns are the client's to
   rewrite (claude-code appends hook output and system reminders to
   its last user turn), so a proof over them would evict the session
   on every turn.
3. **One turn per conversation** — a request that arrives while the
   conversation is turning waits for it and then continues the same
   session (acpx's per-session queue). Before this it opened a twin
   session: twice the provider load for one conversation.

## The request

| Anthropic | ACP v2 | What the gateway does |
| --- | --- | --- |
| `model` | `session/new`'s agent, `session/set_config_option`'s model option | The route prefix (`devin-acp/…`) picks the LANE; the rest is the model's own id and rides the agent's model pin. A model pin that differs from the session's re-pins the session. |
| `messages` | `session/prompt.prompt` (ContentBlock[]) | The conversation's turns. The **delta** past the session's consumed count rides the wire; the rest is session context. |
| `system` (string \| blocks) | — (no field) | Merged into the transcript prefix as a `<system>…</system>` block of the turn that opens the session. |
| `tools` | — (the agent has its own) | Rendered as a tool-contract text block, so the agent knows the client's vocabulary. `tool_choice.type === 'none'` suppresses it and the reply's tool calls are filtered out. |
| `tool_choice` | — | `none` → no contract, no tool calls in the reply. Any other → the contract is declared, the agent decides. |
| `max_tokens` | — (the agent has no budget) | Honoured on the WIRE: the reply is cut at the budget and `stop_reason` reads `max_tokens`. The agent itself may stop earlier. |
| `stop_sequences` | — | Honoured on the wire: the settled text is cut at the first hit and `stop_reason` reads `stop_sequence`; the cut is recorded, so a resend replays the same cut. |
| `temperature`, `top_p`, `top_k` | — (the agent samples) | Read and ignored — the agent owns its sampling. |
| `thinking` | — (no thinking budget) | Ignored. A `thinking` block in the history rides the transcript as text; a signed thinking block cannot be replayed to an agent that did not produce it. |
| `stream` | `session/update` fan-out | The wire's choice: `true` → SSE (`message_start`/`content_block_*`/`message_delta`/`message_stop`), `false` → one buffered `message` object. The agent's updates are the same either way. |
| `metadata.user_id` | — | **The conversation identity** (see above). The native identifier the client already carries. |
| `service_tier`, `speed` | — | Ignored — the tier is the operator's (the lane's provider entry), not the client's. |
| `container`, `context_management`, `mcp_servers`, `output_config` | `session/new.mcpServers`, `session/new.additionalDirectories` | The MCP servers and the extra directories are the CLIENT's and are NOT wired: an ACP agent brings its own. The rest is ignored. |
| `anthropic-beta` header | `initialize` capabilities | Ignored — the gateway speaks the agent's dialect, not a beta of the wire. |

### The content blocks

| Anthropic block | ACP v2 ContentBlock | What the gateway does |
| --- | --- | --- |
| `text` | `text` | Mapped as is. |
| `image` (base64) | `image` (`data`, `mimeType`) | Mapped when the agent advertises the image capability; otherwise it is dropped from the wire with a note in the turn's journal. |
| `image` (url / file) | `resource_link` | The reference rides the transcript as a link; the gateway does not fetch it. |
| `document` (base64 pdf, plain text) | `resource` | The text rides as a resource; a PDF's bytes do not (the agent's own tooling reads files). |
| `tool_use` | — (the agent's own tools) | The client's echo of a tool call rides the transcript as text (`<tool_call>…</tool_call>`), so the agent's context keeps the shape. |
| `tool_result` | — | The client's answer rides as text (`<tool_result for="…">…</tool_result>`). |
| `thinking`, `redacted_thinking` | — | Dropped: a signed thinking block belongs to the model that produced it. |
| `search_result`, `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result` | — | Dropped: those are Anthropic-side SERVER tools, and the agent behind this gateway has its own. |
| `citations` | — | Dropped: the gateway's agent does not cite documents. |

## The response

| Anthropic | ACP v2 | What the gateway does |
| --- | --- | --- |
| `content[].text` | `agent_message_chunk` | The agent's message chunks are the reply's text blocks. |
| `content[].thinking` | `agent_thought_chunk` | The agent's reasoning is not exposed to the client (the wire has no place for it without a signature); it stays in the agent's context. |
| `content[].tool_use` | `tool_call`, `tool_call_update` | The agent's tool calls become the reply's `tool_use` blocks — with the agent's OWN tool names, not the client's contract. |
| `stop_reason` | the prompt's stop reason | `end_turn` / `max_tokens` (the wire's cut) / `stop_sequence` (the wire's cut) / `tool_use` / `refusal`; anything the agent reports that the wire does not know becomes `end_turn`. |
| `stop_sequence` | — | The wire's own answer: which of the client's stop sequences was hit. |
| `usage.input_tokens` / `output_tokens` | `usage_update` | The agent's count when it reports one; otherwise the gateway's estimate. |
| `id` | — | Synthesised per reply (`msg_…`). |
| `model` | the session's model pin | The model that actually served the turn. |
| `role` | — | Always `assistant`. |

## What the gateway adds on top

- **The session budget** (`serve.limits.<entry>.maxSessions`) — how many
  live ACP sessions the lane may hold. The provider's parallel-session
  wall is what a burst of client requests walks into; the cap turns the
  burst into a paced stream (an idle session is recycled LRU, a busy one
  is waited for). A request that cannot get a slot is answered `429`
  with the wait it should honour.
- **The request budget** (`serve.limits.<entry>.requestsPerHour`) — a
  token bucket per `<lane>/<model>`, the SAME host ledger the fleet's
  spawns charge: the gateway and the batch workers draw one account's
  budget, not two.
- **The conversation lock** — one turn per conversation; the second
  request waits and then continues the SAME session.
- **The catalog cache** — the model list is read once (at start, and on
  `POST /api/v1/models/reload`), never per request.

## The gaps, honestly

| Field | Why it cannot be honoured |
| --- | --- |
| `temperature`, `top_p`, `top_k` | The agent owns its sampling; ACP has no knob for it. |
| `thinking` | The agent has no thinking budget, and a signed thinking block cannot be replayed to an agent that did not produce it. |
| `max_tokens` as a hard cap | The gateway cuts the WIRE at the budget; the agent may already have spent more tokens generating. |
| `tools` / `tool_choice` | The gateway can only DECLARE the client's vocabulary to the agent; it cannot make the agent use those tools. |
| `mcp_servers`, `container` | The client's MCP servers are not the agent's; an ACP agent brings its own. |
| `citations`, `server_tool_use` | Anthropic-side server tools; this gateway's agents have their own. |
| `service_tier`, `speed` | The tier is the operator's (the provider entry), not the client's. |
