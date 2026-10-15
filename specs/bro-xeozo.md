# bro-xeozo — conductor: /v1/messages → acp session

Epic bro-om6m8 mode (b). The `/v1/*` plane today only byte-proxies an
HTTP Messages upstream (needs a paid/any upstream key). The goal is the
conductor: claude-code pointed at `ANTHROPIC_BASE_URL=<serve>` sends
`/v1/messages` → bro opens a session on a configured `acp` provider
entry (`devin acp` first — claude-class models through the operator's
existing devin auth, no Anthropic key) → streams the reply back as
anthropic SSE. "The model is an agent": one provider entry decides
which agent CLI answers.

## Wiring

- `BRO_PROVIDER_BACKEND=<name>` env names a `providers.<name>` entry —
  it must be `type: "acp"` (cli entries can't stream a session). When
  set, `/v1/*` routes to the conductor INSTEAD of the byte proxy —
  explicit intent beats `BRO_PROVIDER_UPSTREAM`+key, which stay the
  fallback for a plain HTTP upstream.
- `BRO_PROVIDER_MODEL=<id>` optional pin, wins over `entry.model`. The
  client's requested model id is never trusted — provenance maps to the
  served id in every response `model` field (anthropic clients rename
  built-in rows via `ANTHROPIC_DEFAULT_*_MODEL` anyway).
- Model ids resolve against the session's `configOptions` catalog:
  exact value/name, unique `<id>-` family prefix, loud error otherwise.
  A non-catalog `<base>-<level>` id resolves as a composite when
  `<level>` is a leaf of the `thought_level` option — agents expose
  reasoning-tier aliases this way (devin's `swe-2-max` IS
  `swe-2-high` + `thought_level=max`); both options are applied via
  `set_config_option` and verified against the reported
  `currentValue`s.
- Missing/invalid backend = a loud startup error naming what IS
  configured (the provider-contract error shape), never a silent proxy
  fallback.
- Telemetry: when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (env or
  `~/.config/bro/provider.env`), bro pushes OTLP log events AND spans
  with `service.name=bro`. Span tree: `bro.cmd <cmd>` (per CLI call,
  emitted detached at exit) → `hook.event`/`hook.probe.*` (each hook
  dispatch + each connector probe) → `agent.spawn` (fleet worker —
  carries TRACEPARENT into the child's env so the subagent's own spans
  join the same trace) → `serve.http` → `acp.open`/`acp.session`/
  `acp.turn` → `acp.tool`/`acp.subagent` per ACP session update.
  One session = one trace: an incoming `traceparent` header is honored
  so instrumented callers land in the same trace; callers that don't
  propagate are attributed by process tree (`peer.pid`, `peer.tree`,
  `peer.agent` — resolved via /proc/net/tcp → inode → pid → ppid walk).
  Parent resolution per span: explicit param → ambient cmd ctx →
  TRACEPARENT env. Fire-and-forget, never awaited, never blocks.

## Endpoints

- `POST /v1/messages` — translate + conduct + answer (SSE when
  `stream:true`, the same event sequence; buffered JSON otherwise).
- `GET /v1/models` — the backend's `acpModels` catalog in
  anthropic shape (`{type:'model',id,display_name,created_at}` rows).
- `POST /v1/messages/count_tokens` — char/4 estimate (honest floor —
  claude uses it for compaction planning).
- Anything else under `/v1/` — 404 with the anthropic error envelope.

## Translation

- Request → one ACP prompt: `<system>` block, tool contract, then
  `<turn role="user|assistant">` segments. `tool_use` blocks serialize
  back as `<tool_call>{json}</tool_call>`; `tool_result` as
  `<tool_result for="<id>">`.
- Reply → content blocks in order: text segments become `text` blocks;
  each `<tool_call>{json}</tool_call>` becomes `tool_use` with a
  `toolu_*` id. stop_reason `tool_use` when any call parsed, else
  `end_turn`.

## v1 deferrals (explicit)

- Stateless per call: one session/new per `/v1/messages` (claude
  resends full history anyway). Session reuse across calls is v2.
- Buffered reply: the wire stays SSE but blocks emit after the turn
  ends — a mid-text `<tool_call>` can't be un-streamed. Per-chunk live
  streaming with a rolling fence parser is v2.
- `session/request_permission` answered deny — the conductor needs a
  no-tools agent (`devin acp --agent-type summarizer` shape); a
  permission ask surfaces as a provider error, never a hang.
