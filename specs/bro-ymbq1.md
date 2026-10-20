# bro-ymbq1 — planes: native ACP transport on `bro serve` — brokered agent sessions

Epic `bro-9rls` row: the missing ACP-out transport. `bro serve` already
brokers Messages-API clients through a pooled `devin acp` peer (the
conductor, specs/bro-xeozo.md); this spec adds a second transport that
passes the **native ACP protocol** through untranslated, so an
ACP-capable client (Zed, a `devin acp` client, any JSON-RPC ACP client)
gets the full wire: `session/update` streaming, the `tool_call`
lifecycle, `terminal/*`, `fs/*`, `session/request_permission`,
elicitation.

## Problem

The conductor is a *translation* — ACP in, Anthropic Messages out. A
client that already speaks ACP pays the lossy serialization anyway:
live updates arrive post-hoc, tool calls are `<tool_call>` text
conventions, and client-served capabilities (permission prompts, fs,
terminals) never exist. Fidelity beads (bro-728wl, bro-eua0d, bro-btccj)
patch the translation layer one protocol concept at a time; the cheaper
and more honest answer for an ACP-capable client is no translation at
all — a broker:

```text
ACP client <== streamable http ==> bro serve <== acp ==> pooled agent peer
```

serve stays in the middle for what it is good at — provider registry
(`BRO_PROVIDER_BACKEND`), model pinning, the warm pool, otel spans,
session attribution, the serve.json token boundary — but the PROTOCOL
passes through untranslated.

## Transport decision: ACP Streamable HTTP via the SDK's `AcpServer`

Mounted at `/api/v1/acp` — `POST` carries one JSON-RPC message per call
(the first `initialize` answers synchronously and returns
`Acp-Connection-Id`), `GET` with `Accept: text/event-stream` opens the
agent→client SSE stream (connection-level, or per-session with
`Acp-Session-Id`), `DELETE` tears the connection down. This is the
bead's "POST-per-call + SSE-out" option — specifically the
protocol-standardized version of it that `@agentclientprotocol/sdk`
1.7 already ships under `experimental/server` + `experimental/node`:

- No invented framing and no new dependency — the SDK owns the
  connection registry, `Acp-Connection-Id`/`Acp-Session-Id` routing,
  pending-response routes, per-session outbound stream leases, and the
  backpressure/stall limits (`maxOutputStallMs` 60s default reaps a
  client that never drains).
- `experimental/http-client`'s `createHttpStream` is the matching
  client — tests exercise the real HTTP transport end-to-end, and any
  SDK consumer can already speak it.
- Duplex correctness is the hard part of a hand-rolled ndjson duplex —
  agent→client requests must interleave with client→agent ones on one
  logical connection; the streamable split is how the protocol itself
  solves it over HTTP.

Rejected: a bespoke `application/x-ndjson` POST-stream transport
(the bead's first option) — it reinvents exactly what `AcpServer`
implements, plus a framing no ACP client already speaks.
WS stays unmounted (no `ws` dep in the tree; the SDK's
`prepareWebSocketUpgrade` remains available if a client ever needs it).

## The warm pool carve-out — one pool, two links

The bead asks the transports to "share the same pooled peer". The warm
*machinery* is shared — the lazy spawn-once link, respawn-on-death,
process-exit close — but the ACP link is a second logical connection
through the same pool, because `initialize` negotiates
`clientCapabilities` **once per upstream connection**. The conductor's
link deliberately advertises `fs:false, terminal:true` — fs is never
served, terminal runs through the local AcpTerminals registry
(bro-z7afs) — and answers permission with deny (spec bro-5hx1.1 §7–8 —
that posture IS the /v1 contract). The ACP link must advertise the union
(`fs:{read,write}:true`, `terminal:true`) or agent→client delegation
never reaches the downstream client. One upstream connection cannot
hold both contracts, and silently upgrading the conductor's would
retool every `/v1/messages` turn through client-served fs/terminal —
the "conductor stays untouched" clause loses. Cost: one extra idle
`devin acp` child, spawned only when the ACP transport is actually
used; sessions still multiplex on their transport's link.

## Wire table — what passes through

| downstream → bro | bro → upstream |
| --- | --- |
| `initialize` | opens (or joins) the pooled ACP link eagerly; response = upstream `protocolVersion`, `agentCapabilities` minus `loadSession`, `authMethods`, `agentInfo` verbatim |
| `session/new` | `session/new` with the client's params verbatim (`cwd`, `mcpServers`, `_meta`) + the configured model pin applied via `session/set_config_option`; response verbatim (upstream `sessionId` is the downstream id — untranslated) |
| `session/prompt` | verbatim `ContentBlock[]`; every `session/update` fanned out **as it arrives** (the `onUpdate` seam, never buffered to `end_turn`); upstream `PromptResponse` verbatim back |
| `session/cancel` (notif) | `session/cancel` notification verbatim |
| `session/set_config_option`, `session/set_mode`, `authenticate` | verbatim request forward, response verbatim |
| `session/close` | `session/close` forward + the brokered handle is released |

| upstream → downstream | routing |
| --- | --- |
| `session/update` | owning connection's client context |
| `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `elicitation/create`, `mcp/message` | looked up by `params.sessionId` → the session's owning connection, verbatim both ways; an unknown session answers method-not-found |
| `elicitation/complete` (notif) | same routing, forwarded as notification |

| NOT brokered in v1 | behavior |
| --- | --- |
| `session/load`/`resume`/`fork`/`list`/`delete` | unregistered → method-not-found; `loadSession` is stripped from advertised `agentCapabilities` so well-behaved clients never call it |
| `providers_*`, `logout`, `nes_*`, `document_*` | method-not-found |
| concurrent `session/prompt` on one session | JSON-RPC error — a second pump would steal the first turn's updates (the update queue is per-session, single-reader) |
| agent updates outside a prompt turn | queued by the SDK's session routing and flushed at the next turn's pump — the pump is the only queue reader |

## Lifecycle

- One `AcpServer` per listener; `createAgent` mints the per-connection
  `agent()` app. Each connection records its `clientInfo` (otel
  attribution) and owns its `session/new`'d sessions.
- Brokered-session map: upstream `sessionId` → `{retained, client,
  busy, lastSeen}`; the upstream id is used verbatim downstream.
  Swept at each `session/new` — 10-min TTL, 32-session cap, the
  conductor's posture; a failed turn evicts (close upstream
  best-effort + unindex), a mid-turn session is never swept.
- Client disconnect (DELETE, socket death, or the SDK's output-stall
  close) resolves `conn.closed` → that connection's sessions are
  disposed locally and `session/close`'d upstream best-effort — the
  client disconnect never leaks the peer session.
- Link death → every brokered session drops (the conductor's
  `dropSessions` convention); the next request respawns the link.
- Process exit closes the link (same `process.once('exit')` hook the
  conductor uses) — no orphaned `devin acp` child.

## Auth / mounting

`/api/v1/acp` rides the same raw-stream seat as `/v1/*` and
`/api/v1/agents/<ref>/log` — below the `ServeResponse` envelope because
POST bodies are JSON-RPC messages and GET answers a long-lived SSE
stream. The guard is `providerGuard`'s: `Authorization: Bearer` or
`x-api-key` == serve.json token on EVERY method (a blinded
`session/prompt` spends agent budget), loopback `Origin` when present,
`content-type: application/json` on body-bearing posts. Loopback `Host`
stays the global gate.

## providers/acp.ts surface

- `AcpSeam` += `clientCapabilities?: ClientCapabilities` — advertised at
  upstream `initialize` (default unchanged: `fs` both false,
  `terminal: true`);
  `bridge?: AcpClientBridge` — when set, every client-bound method
  (`session/request_permission`, `fs/*`, `terminal/*`,
  `elicitation/create`, `mcp/message`) delegates to
  `bridge.request(method, params)` and `elicitation/complete` to
  `bridge.notify(...)`; unset → today's `denyPermission` posture.
- `AcpPeer` += `init: InitializeResponse` — the upstream handshake
  result, so the broker can answer downstream `initialize` with the
  agent's real capabilities.
- `PooledTurnOpts` += `sessionRequest?: NewSessionRequest` —
  `acpSessionRetain` opens the session with the client's params
  verbatim instead of the synthesized `{cwd, mcpServers:[]}`.
- `AcpRetainedSession` += `newSessionResponse`, and `prompt()`'s return
  type gains the already-present `response: PromptResponse` so the
  broker answers `session/prompt` with the upstream response verbatim.

## Otel

Conventions match the conductor: a `serve.http` span per ACP HTTP
request (peer attribution via `peerAttrs`, `traceparent` honored), and
the brokered open/turn ride the existing `acp.open` / `acp.session` /
`acp.turn` spans with `acp.by` = `acp-transport:<backend>` — tool_call
and subagent spans come free through the shared `pumpTurn` traced
sink. Session attribution: `acp.client` = downstream `clientInfo.name`,
plus `bead` inferred from a `bro--<id>`-shaped session cwd when one is
sent.

## Tests

`serve-acp.test.ts` — `createHttpStream` client over the real HTTP
listener, `fakeAcpAgent` as the upstream peer (`acp.peer` seam):

- `initialize` → downstream sees the agent's advertised capabilities
  (minus `loadSession`).
- `session/new` + `session/prompt` → upstream records the verbatim
  params; `session/update` updates arrive at the client during the
  turn, before the prompt resolves.
- `session/request_permission` + `fs/read_text_file` from the agent
  reach the client handler and the client's answer returns upstream.
- `session/cancel` forwards to the agent; client disconnect/DELETE
  releases the session (`session/close` observed upstream).
- guard parity: 401 without the token.

testkit gains: `cancels`/`closes` recording, a `probeClient` mid-prompt
client-call script, and an `agentCapabilities` advertise option.

## Non-goals

- Multi-backend routing, `session/load`-family resume, bro-side
  MCP-server injection, WS mounting.
- Serving fs/terminal requests *locally* for conductor-owned sessions
  (the shared-link design that would require it).
- Closing the bead or merging without the act gate.

## Verify

- `npm run typecheck`
- `npx tsx --test packages/cli/src/commands/serve-acp.test.ts
  packages/cli/src/commands/serve-conductor.test.ts
  packages/cli/src/commands/serve.test.ts
  packages/providers/src/acp.test.ts` (the touched-file set)
- `npm test` if the scoped set is green fast enough to afford it.
