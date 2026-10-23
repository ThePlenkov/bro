---
parent: bro-l67jh
scope:
  - packages/providers/src/acp-proxy.ts
  - packages/cli/src/commands/acp.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/plugins.ts
  - skills/acp/
---

# bro-rs8sp — acp: edge design spec — proxy vs agent mode, hook↔ACP event mapping

Parent: `bro-l67jh` (epic — bro speaks ACP outward). This doc pins the
edge shape before bro-bhyo1 (proxy), bro-9qopj / bro-u2eps (seam
policy), and bro-tegz2 (agent mode) build on it. It decides, it does not
implement.

## Problem

bro consumes ACP strictly as a client today: `providers/src/acp.ts`
(judge/conductor calls), `acp-worker` (fleet spawn driver), the `/v1`
conductor (Anthropic SSE → pooled ACP turns). Every host integration —
`hooks.json` for claude/devin, cursor's stdin dialect, codex —
re-implements bro's hook vocabulary client-side. The epic's wager: put
bro ON the ACP wire so any ACP client (Zed, JetBrains, Devin's own CLI)
gets bro's hooks, gates, and skills at the protocol seam instead of
seven adapters.

Before code, three things must be pinned so the children don't invent
incompatible variants:

1. Which wire shape the edge takes — a transparent proxy in the middle,
   or bro as the terminal agent.
2. What the current ACP spec and the pinned SDK actually permit — proxy
   chains are a live upstream RFD, not shipped spec.
3. How bro's hook events map onto ACP methods and notifications — and,
   just as important, where they can't.

## Spec state survey (recorded 2026-10-21, updated 2026-10-23)

- **Pinned SDK**: `@agentclientprotocol/sdk` `^1.7.0`, lockfile-resolved
  **1.7.0** → `PROTOCOL_VERSION = 1`. Agent-side API ships in this
  version: `agent()` → `AgentApp.onRequest(AGENT_METHODS.*)` /
  `onNotification` / `onConnect` → `connect(stream)`. Custom methods
  register via the `onRequest(method, paramsParser, handler)` overload,
  and the low-level `JsonRpcHandler` chain (`Handled.no()` / `retry`)
  supports pass-through dispatch — a transparent proxy does not need to
  fork the SDK. `AgentSideConnection` is deprecated in the 1.x line and
  **removed in 2.x**.
- **SDK 2.x landed post-survey**: 2.0.0 (2026-10-19) / 2.0.1
  (2026-10-22) drop the legacy `Agent`/`Client`/`AgentSideConnection`/
  `ClientSideConnection` classes — `agent()`/`client()` apps are the
  only API, which is the shape this spec prescribes anyway. Critically,
  **SDK 2.0 does not switch the default protocol from ACP v1** — v1
  stays the default under `dist/v1/`, v2 is the experimental
  `dist/v2/` entrypoint. An SDK major bump is a dependency event, not
  a wire event; the two bump on independent axes. Latest 1.x is 1.9.0
  (schema v1.26.0).
- **ACP v2**: published, still labeled draft as a whole (stable
  baseline schema; negotiated via `protocolVersion: 2`). The prompt
  lifecycle is redesigned — `session/prompt` only acknowledges, turn
  completion and `stopReason` arrive as `state_update` notifications
  (`Running`/`Idle`/`RequiresAction`/`Unknown` states in the SDK's v2
  schema) — and the client `fs/*` + `terminal/*` methods are removed.
  **Not our wire**: the pinned SDK speaks v1 by default. The proxy
  forwards the negotiated version; it never chooses one. Revisit the
  mapping at a protocol-version bump.
- **Proxy chains**: upstream RFD "Agent Extensions via ACP Proxies"
  (nikomatsakis, published at agentclientprotocol.com/rfds/proxy-chains)
  — a proposal with a Rust implementation (`sacp` upstreamed as
  `agent-client-protocol` v1.0 for Rust, plus
  `agent-client-protocol-conductor`). It introduces `proxy/initialize`
  plus bidirectional `proxy/successor`, and a conductor that owns
  routing so proxies never know their successor. **Not in the v1 or v2
  schema, not in the TS SDK** — verified absent through SDK 2.0.1.
- **Slash commands (v1)**: `available_commands_update` session/update
  notification carrying `AvailableCommand { name, description,
  input?.hint }`. Invocation arrives as literal `/name args` text inside
  `session/prompt` — no dedicated method.
- **Permission (v1)**: agent→client `session/request_permission`
  `{ sessionId, toolCall, options[] }` → `{ outcome: selected optionId
  | cancelled }`. Option kinds: `allow_once` / `allow_always` /
  `reject_once` / `reject_always`.
- **Turn end (v1)**: `session/prompt` response `stopReason` ∈
  `end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
  (`refusal` is the schema literal — not `refused`.)
- **`session/new` (v1)**: `{ cwd, mcpServers[], _meta,
  additionalDirectories? }` — **no context field**. Injected context
  lands in the session's first `session/prompt` as a prepended content
  block: `text` always, or `resource` (embedded) when the downstream
  advertises `promptCapabilities.embeddedContext`.
- **Extensibility that already exists**: `_meta` on every request,
  `_`-prefixed custom methods, SDK catch-all dispatch. The proxy
  invents no methods.

## Decision: cascading proxy first, agent mode second

**`bro acp proxy -- <agent cmd>` ships first.** bro is the ACP agent to
the client and the ACP client to the spawned downstream — a *cascading*
proxy that knows its successor (the argv it spawns). This is
deliberately NOT the RFD's conductor model, where a proxy is
successor-agnostic and a conductor routes `proxy/successor`. Rationale:

- Zero protocol changes — works today against stock v1 agents. The RFD
  is a proposal; waiting for `proxy/*` methods the TS SDK doesn't carry
  stalls the seam indefinitely.
- The RFD itself names the cascade as the working alternative; its cost
  (proxy knows its successor) is exactly what we want — the operator
  names the successor on the command line.
- If the RFD lands, bro can adopt `proxy/initialize`/`proxy/successor`
  via the SDK's custom-method seam — a later mode, not a rewrite. This
  spec keeps every intercept point enumerated below so that swap stays
  mechanical.

**`bro acp` (agent mode) defers to bro-tegz2.** bro-as-terminal-agent
needs session↔provider routing policy (which providers entry, model
selection per session, the slash-command vocabulary over the CLI
contract) — design mass the first seam shouldn't carry.

## Forwarding contract (proxy mode)

Default is **verbatim** — method, params, `_meta`, and error envelopes
pass through untouched in both directions. Intercepted:

| Wire point | Direction | What bro does |
| ---------- | --------- | ------------- |
| `initialize` | C→A | Forward `protocolVersion` and `clientCapabilities` unchanged; report the downstream's negotiated result upstream — the proxy never negotiates a different version or claims caps it won't serve. |
| `session/new` (+ `session/load`/`resume` when the downstream advertises them) | C→A | Forward verbatim; stamp a pending-context buffer on the session id. |
| `session/prompt` | C→A | Run prompt-submit seam; prepend pending context into the session's first prompt. |
| `session/cancel` | C→A | Forward verbatim; record. |
| `session/update` | A→C | Forward verbatim; observe for the event plane and the mapping below. |
| `session/request_permission` | A→C | Forward to the client by default — the permission hook may answer earlier (policy is bro-9qopj). |
| everything else | both | Verbatim — including `fs/*`, `terminal/*`, `elicitation/*`, MCP-related methods, and unknown `_`-methods via the SDK's catch-all. |

Downstream argv after `--` is exec'd directly — no shell. (Provider
entries shell out through `sh -c` only because they carry
operator-authored config strings; an argv tail is already tokenized.)

The hook seam is an **in-process library call**, not a `bro hooks`
subprocess: the connector probes behind `emitSessionContext` /
`emitPromptContext` / `emitPermission` extract into a callable surface
returning `{ context?: string; verdict?: 'allow'|'ask'|'deny' }`. The
CLI stdin→stdout contract stays the semantic spec; the library is the
same code without the pipe. `BRO_HOOKS=0` must NOT be pinned — the
proxy serves a human-facing client, the opposite of `acpChildEnv`'s
machine-backend mark.

## Hook ↔ ACP event mapping (the contract)

| bro hook event | ACP wire point (v1) | Dir | Proxy semantics | Fidelity |
| -------------- | ------------------- | --- | --------------- | -------- |
| `session-start` | `session/new` (+ `load`/`resume`) | C→A | Run session-start probes once per session; output becomes the pending context injected into the first prompt. | Context can't ride `session/new` itself — injection is necessarily deferred to the first `session/prompt`. |
| `post-compaction` | none in v1 | A→C | **Gap**: fires only if the downstream emits the `compaction_update`/`session_info_update` variants the schema carries — stable in the current v1 schema but gated on the *client* advertising `sessionCapabilities.compaction`, which the proxy forwards verbatim. | Recorded gap, not emulated. |
| `pre-compact` | none in v1 | A→C | Same gap. | — |
| `prompt-submit` | `session/prompt` | C→A | Prompt content blocks are the hook input; returned context prepends to the same prompt. | Faithful. |
| `pre-tool` | `tool_call` update (non-terminal); veto only via `session/request_permission` | A→C | **Advise-only on updates** — a `tool_call` announcement means the agent already committed; the wire's only veto point is answering the permission request with a reject. Pre-tool guard verdicts map onto the permission path, never onto `tool_call` rewriting. | Semantics narrowed vs Claude's PreToolUse — recorded, not papered over. |
| `post-tool` | `tool_call` / `tool_call_update` reaching terminal status (`completed`/`failed`) | A→C | Post-execution report — journal/trace lines same as today. | Faithful. |
| `permission` | `session/request_permission` | A→C | `allow` → `allow_once`; `ask` → forward upstream; `deny` → `reject_once` (or `cancelled` when no reject option is offered — the `denyPermission`/`autoApprove` shapes already proven in acp.ts/acp-worker). | Faithful. |
| `stop` | `session/prompt` response (`stopReason`) | A→C | **v1: observe and record** (`turn stop` on the agent plane, stop-gate verdict logged). A gate that wants continuation would hold the upstream request open and issue one more downstream `session/prompt` — that semantic change is bro-u2eps's spec decision, not this one's. | Report-only in v1 of the proxy. |
| (cancel) | `session/cancel` notification | C→A | Forward; record as an interrupted turn. | Faithful. |
| (elicitation) | `elicitation/create` | A→C | Forward; no bro hook exists for it. | Faithful. |

## Agent mode (`bro acp`) — shape deferred to bro-tegz2

Sketch only, to show the seam generalizes: `agent()` app over stdio;
`initialize` negotiates v1; `session/new` binds the session to a
`providers.<name>` entry; `session/prompt` runs `acpPooledTurn` and
relays `onUpdate` back as `session/update` notifications;
`session/request_permission` forwards upstream (a human is present —
never `denyPermission`); `available_commands_update` advertises the CLI
contract as slash commands.

## Failure and latency contract

- Downstream dead at `initialize` → the client gets the downstream's
  real error — never a synthesized success.
- Downstream dies mid-session → pending requests error and surface;
  nothing is faked.
- Hooks run only at the mapped seam points — never per `session/update`
  chunk. Text deltas must not pay a hook probe.
- Telemetry: `acp.proxy.session` / `acp.proxy.turn` spans under the
  existing `otelSpan` tree; updates reuse `agentTurnPlane` (bus topic +
  `.events.jsonl`) keyed by the upstream session id.
- Per-turn overhead is measured and documented in bro-bhyo1's
  acceptance, not asserted here.

## Non-goals

- **No invented protocol.** No bro-specific methods, no `_meta`
  protocol — everything rides spec'd seams and documented extension
  points.
- **MCP passthrough untouched.** `session/new.mcpServers` forwards
  verbatim; bro neither filters nor injects MCP servers in this spec.
- **No v2 implementation.** v2 tracking is an SDK-bump event, not a
  proxy feature.
- **No conductor-mode `proxy/*` support yet.** Adoption waits on the
  upstream RFD landing in the TS SDK.

## Open questions

- When the proxy-chains RFD lands in the TS SDK: does bro grow a
  `proxy/initialize`-capable mode (bro as a proxy component under
  `sacp-conductor`), or stay a pure cascade edge? Track upstream; the
  cascade stays valid either way.
- Should the injected context block carry a `bro:` marker/`_meta` so
  the downstream agent can tell injected context from user text?
  (Honesty argues yes; client compatibility argues the plainest block
  that works.)
- The SDK-major and protocol-version axes decouple: SDK 2.x still
  defaults to wire v1, so the next dependency bump is mechanical
  (legacy classes already gone — this spec's `agent()`/`client()`
  shape survives). The *protocol* v2 question stays open: the stop row
  moves to `state_update` notifications and the prompt response
  becomes an ack — does the mapping table need a v2 twin, or does the
  seam stay v1-shaped behind version negotiation?
- Permission default when the client's answer is `cancelled`: forward
  the cancel verbatim (current design) or convert to reject? Keep
  verbatim — `cancelled` is honest.
- Should `bro acp proxy` assert v1 like acp.ts does? **No** — the
  assertion belongs to bro's own client calls; the passthrough is
  version-agnostic by construction.

## Verify

- This spec is its own acceptance: mapping table, mode decision, SDK
  pin, and open questions recorded.
- Children carry the executable proof: bro-bhyo1's e2e against
  `fakeAcpAgent` (messages round-trip verbatim except the injected
  block; latency measured), plus a manual pass against `devin acp` and
  `kilo acp`.
