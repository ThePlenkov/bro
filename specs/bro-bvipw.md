# bro-bvipw — full client support: claude + codex through the gateway, with an e2e test tree

## Problem

The conductor serves one dialect (`/v1/messages`, anthropic-shaped)
over the canonical pipeline `request → transcript → acp turn →
blocks`. Claude Code runs on it today, but the coverage is "enough
for the dogfood", not "every feature and setting". Codex — the
second client the user wants — speaks OpenAI's `/v1/responses` and
has no path at all. Meanwhile per-repo listeners multiply gateways
(bro-dluwn): the API plane is a host service, not a repo feature.

This epic has three inseparable halves: **(a)** the anthropic plane
finished — every field Claude Code can send behaves correctly or is
explicitly documented as a no-op; **(b)** the OpenAI plane —
`/v1/responses` (codex's wire) as a second dialect over the same
canonical seam; **(c)** a detailed test tree proving each —
hermetic integration tests per dialect + agentic dogfood scenarios
driven by the real clients.

## Architecture

The canonical pipeline stays dialect-agnostic:

```
ingress parse (per dialect)
  → canonical request { system, transcript, tools, pin, stream }
  → acp turn (retained session per conversation)
  → egress render (per dialect): SSE events or buffered JSON
```

A dialect is a pair of translators; nothing dialect-specific leaks
below the seam. The `<tool_call>` reply-markup emulation is shared
— each egress renders it as its own tool-call shape.

## Feature matrix — Claude Code (anthropic plane)

### Wire: `POST /v1/messages`

| feature | status | note |
|---|---|---|
| `messages` text turns | ✅ | serialized into `<turn>` transcript |
| `system` string / block array | ✅ | `<system>` prefix |
| `tools` definitions | ✅ | `<tools>` contract; replies parse `<tool_call>` markup → `tool_use` blocks |
| `tool_result` blocks | ✅ | `<tool_result for=…>` markup inbound |
| image content (base64) | ✅ | real ACP image when `promptCapabilities.image`, else `[image]` marker |
| `stream: true/false` | ✅ | SSE events / buffered message |
| `model` pin | ✅ | `provider/model` composite + `<base>-<level>` → thought_level |
| `[1m]` context suffix | ✅ | stripped to base pin |
| multi-turn retention | ✅ | history fingerprint + `x-bro-session` pin |
| `max_tokens` | ⚠️ ignored | ACP exposes no cap — document as accepted no-op |
| `stop_sequences` | ❌ | **implement**: post-filter deltas, cut at marker |
| `tool_choice` | ❌ | **implement**: auto/none → contract on/off; any/tool → "must call" contract line |
| `temperature`, `top_p`, `top_k` | ⚠️ ignored | no ACP knob — accepted no-op, documented |
| `thinking` / extended thinking | ❌ | **decide**: map budget → thought_level pin, or emit thinking blocks? |
| `metadata.user_id` | ⚠️ ignored | accepted no-op (privacy-safe) |
| `cache_control` | ⚠️ ignored | retained session *is* the cache — document |
| `service_tier`, `context_management`, `container`, mcp-in-request | ⚠️ ignored | accepted no-op |
| unknown fields | ✅ | tolerated silently |

### Wire: other endpoints

| endpoint | status |
|---|---|
| `POST /v1/messages/count_tokens` | ✅ estimate |
| `GET /v1/models` | ✅ catalog rows |

### Error taxonomy (currently thin — implement)

| case | today | target |
|---|---|---|
| backend dead/unspawnable | 529 `overloaded_error` | keep |
| backend quota/rate-limited | 529 | 429 `rate_limit_error` + `Retry-After` |
| malformed body / bad field | 500-ish | 400 `invalid_request_error` |
| bad/missing token | 401 | keep + `authentication_error` type |
| unknown model pin | ? | 404 `not_found_error` |
| mid-stream turn failure | in-stream `error` event | keep |

### SSE nuances

- `ping` keepalive events during slow ACP turns — **implement** if
  absent: Claude Code's read timeout is the real constraint.
- `message_start`/`content_block_*`/`message_delta`/`message_stop` ✅.

### Claude Code settings surface

| setting | gateway cares? |
|---|---|
| `model` (`devin/swe-2-max`) | ✅ composite pin resolved per request |
| `apiKeyHelper` | ✅ prints token; `bro serve ensure` keeps listener up |
| `env.ANTHROPIC_BASE_URL` | ✅ points at the listener |
| `env.ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` | ⚠️ deprecated by `model` — conductor still maps ids |
| `env.ANTHROPIC_SMALL_FAST_MODEL` | ✅ **gap**: background classifier calls hit this pin — must map to a served model or the default entry |
| `enabledPlugins bro@bro` | n/a gateway — plugin is client-side |
| hooks, permissions, statusline, telemetry | n/a — client-side, out of scope |

## Feature matrix — Codex (OpenAI plane, NEW)

Codex's wire is `/v1/responses` — not chat/completions (codex's
`wire_api = "responses"`). `/v1/chat/completions` stays optional
compat, deferred until a real client needs it.

### `POST /v1/responses` — ingress

| field | handling |
|---|---|
| `model` | same composite pin resolution |
| `input` string | one user turn |
| `input[]` items: `message` | role/content parts (`input_text`, `input_image`, `output_text`) → transcript |
| `input[]` items: `function_call` | → `<tool_call>` history markup |
| `input[]` items: `function_call_output` | → `<tool_result>` markup |
| `input[]` items: `reasoning` | opaque — skip (backend owns its reasoning) |
| `instructions` | → `<system>` |
| `tools` (function defs) | same `<tools>` contract |
| `tool_choice` | same semantics as anthropic gap work |
| `parallel_tool_calls` | accepted no-op (emulation is sequential anyway) |
| `previous_response_id` | → session retention key (chains a turn to its predecessor) |
| `store: false` | stateless mode — still keyed by history fingerprint |
| `reasoning.effort` | **the fit**: `low|medium|high` → thought_level |
| `max_output_tokens` | accepted no-op |
| `text.format`, `metadata`, `include`, `background`, `truncation` | accepted no-op |

### `POST /v1/responses` — egress

Stream (`stream:true`), item-ordered:

```
response.created → response.in_progress
→ response.output_item.added (message)
→ response.content_part.added → response.output_text.delta*
→ response.content_part.done → response.output_item.done
→ response.completed (usage attached)
```

Tool call: `response.output_item.added` (function_call) →
`response.function_call_arguments.delta*` → `.done` → item.done.

Non-stream: buffered `{id, object:'response', status:'completed',
output[], usage, error:null}`.

### `GET /v1/models` — OpenAI shape

`{object:'list', data:[{id, object:'model', created, owned_by}]}`
over the same catalog.

### Errors

OpenAI envelope `{error:{message,type,param,code}}` + HTTP codes —
separate from the anthropic envelope; the dialect owns its shape.

### Codex settings surface (config.toml)

| key | gateway cares? |
|---|---|
| `model`, `model_provider` | ✅ pin resolution |
| `model_providers.<n>.base_url` | ✅ → listener |
| `model_providers.<n>.env_key` | ✅ → bro token env |
| `model_providers.<n>.wire_api` | must be `responses` |
| `model_providers.<n>.http_headers`/`env_http_headers`/`query_params` | tolerated |
| `model_providers.<n>.{request,stream}_max_retries`, `stream_idle_timeout_ms` | client-side; keepalive ping serves it |
| `model_reasoning_effort` | ✅ → thought_level |
| `profiles.*`, `sandbox_mode`, `approval_policy`, `mcp_servers`, `notify`, `history`, `instructions` | client-side, out of scope |

Provider side: a `providers.codex` template + scenario files that
write the `config.toml` block — the apiKeyHelper analog is an env
export (`BRO_*` token).

## Test tree

### Integration (hermetic — fake ACP peer, `tsx --test`)

```
packages/cli/src/commands/
  serve-conductor.test.ts            anthropic plane (exists, 35)
  serve-conductor-features.test.ts   anthropic gaps
    ├─ tool_choice auto/any/tool/none → contract variants
    ├─ stop_sequences: mid-stream cut, buffered cut, multi-seq
    ├─ keepalive ping cadence on held turns
    ├─ error taxonomy: 429+Retry-After, 400 invalid_request, 401, 404 model
    └─ ANTHROPIC_SMALL_FAST_MODEL maps to a served pin
  serve-conductor-codex.test.ts      responses dialect
    ├─ input string + items → transcript
    ├─ function_call/output items → tool markup round-trip
    ├─ reasoning.effort → thought_level pin on the acp session
    ├─ previous_response_id → session continuity
    ├─ stream event order (created→item.added→delta→done→completed)
    ├─ non-stream buffered Response + usage counts
    ├─ OpenAI error envelope + codes
    └─ /v1/models in OpenAI shape
```

### Agentic e2e (dogfood scenarios — real clients on the gateway)

```
dogfood/
  claude-plugin.md      exists — native commands + hooks e2e
  claude-basics.md      model pin, streaming, multi-turn — headless claude
    .files/             settings.local.json + apiKeyHelper + config
  claude-tools.md       real tool_use loop: claude edits a file via tools
  claude-errors.md      backend killed mid-run → retry/recovery observed
  codex-basics.md       codex exec one task through /v1/responses
    .files/             config.toml (model_providers bro, wire_api=responses)
  codex-tools.md        function_call loop: codex applies a patch
  codex-reasoning.md    model_reasoning_effort reaches the backend pin
  codex-plugin.md       codex uses bro as a shell tool (AGENTS.md path —
                        codex has no plugin surface; the scenario proves
                        bro's CLI is the portable contract)
  matrix.md             index — one row per scenario ↔ matrix row
```

Each scenario asserts in the bro store: serve.log shows the dialect's
turns, the runner transcript names the surfaces exercised, the
analyst verdict maps steps to matrix rows.

## Children

- `bro-zkpju` — the `/v1/responses` dialect itself (this spec's §codex wire)
- `bro-dluwn` — host-scope gateway (both dialects ride one listener)
- `bro-ofbw4` — lifecycle: no dead-listener windows under any client
- NEW `anthropic-gaps` — tool_choice, stop_sequences, error taxonomy,
  keepalive, small-fast-model mapping
- NEW `codex-provider` — `providers.codex` template + config.toml
  provisioning + env_key token path
- NEW `e2e-tree` — the dogfood scenario set + hermetic suites above

## Verify

- every matrix row marked ✅/❌ lands as a test or a documented no-op
- `claude -p` headless on the gateway: tool_use round trip
- `codex exec` on the gateway: function_call round trip
- both clients' retries behave on induced backend failure
- dogfood runs land evidence + analyst verdict in the bro store
