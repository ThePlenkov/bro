---
title: bro fleet status + bro fleet serve
description: The compact live board in one read, and the loopback HTTP facade for thin clients.
---

*Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`).*

## `bro fleet status`

One read returns everything a thin client (pi extension, TUI, dashboard)
needs per refresh tick — active beads, fleet workers, the drill frame,
git state — where N shell calls per tick used to be the only way. All
state is read, never mutated; bead-less or registry-less checkouts still
answer, with the absent sections empty or null.

| Command | What it does |
| ------- | ------------ |
| `bro fleet status` | Compact human board — beads, fleet, drill, git |
| `bro fleet status --json` | The same board, machine-readable — the thin-client contract |
| `bro fleet status --deep` | Plus the act exit gate for the current branch's PR (network — the fast path stays local-only) |

Sources: `bd` (in-progress + ready, capped), the shared agent registry
(`<git-common>/bro/agents.json` — shared across linked worktrees), the
drill stack, git porcelain, and the heartbeat file
(`<git-common>/bro/heartbeat.json` — rewritten by every `bro review watch`
tick; the `watch:` row is the rig's liveness read).

## `bro fleet serve`

`bro fleet serve [--port N]` is the write-capable counterpart: a foreground,
loopback-only HTTP/JSON facade so thin clients never shell out to
`bd`/`gh` themselves. The 127.0.0.1 bind is the trust boundary — no
`--host` flag. The bound URL and session token are printed and written
to `<git-common-dir>/bro/serve.json` (mode 0600); every mutation
requires `Authorization: Bearer <token>`.

| Route | Purpose |
| ----- | ------- |
| `GET /` | Service index |
| `GET /fleet` | Fleet web UI |
| `GET /ui` | Plane-catalog dashboard — one panel per plane, generated from the index |
| `GET /api/v1/health` | Liveness |
| `GET /api/v1/snapshot` | Watch snapshot |
| `GET /api/v1/agents` | Agent plane |
| `GET /api/v1/agents/<ref>` | One agent by ID or molecule step |
| `GET /api/v1/agents/<ref>/log?lines=N[&follow]` | Agent log tail — `follow` upgrades to SSE |
| `POST /api/v1/agents` | Spawn an agent |
| `DELETE /api/v1/agents/<ref>` | Stop an agent |
| `GET /api/v1/planes` | Plane-catalog index — reads, verbs, live capabilities |
| `GET /api/v1/planes/<plane>` | The plane's `list()` — `status`, `limit`, filters |
| `GET /api/v1/planes/<plane>/<read\|ref>` | A declared read, or `get(ref)` |
| `POST /api/v1/planes/<plane>/<verb>` | Execute a declared verb — body is the args object |
| `GET /api/v1/events/stream` | SSE over the local bus — `Last-Event-ID` resume |
| `GET /api/v1/events/asyncapi.json` | Generated AsyncAPI schema for the stream |
| `POST /api/v1/webhooks/github` | GitHub webhook ingest → `github:*` bus topics (HMAC auth, not the session token) |
| `ALL /v1/*` | The Messages-API provider plane — byte proxy by default, conductor when `BRO_PROVIDER_BACKEND` is set |

### Provider plane — proxy and conductor

`/v1/*` speaks the Anthropic Messages API and authenticates on the
session token (`Authorization: Bearer` / `x-api-key`), GETs included —
an unauthenticated call would spend the upstream credential anyway.
Which engine answers is fixed by the server's own env, never the
client request:

| Mode | Armed by | What answers |
| ---- | -------- | ------------ |
| proxy | `BRO_PROVIDER_API_KEY` (falls back to `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`); `BRO_PROVIDER_UPSTREAM` overrides `https://api.anthropic.com` | A byte proxy — SSE frames, `tool_use` blocks, and beta surface pass through untouched while the session token is swapped for the real upstream key |
| conductor | `BRO_PROVIDER_BACKEND=<name>` naming a `type: "acp"` [provider](/docs/commands/providers) entry | A conducted ACP session — the model is an agent (`devin acp` carries claude-class models through the operator's existing devin auth, no Anthropic key) |

Conductor knobs: `BRO_PROVIDER_MODEL` pins over the entry's `model`
(the client's requested id is never trusted), `BRO_PROVIDER_CATALOG`
names a second providers entry whose catalog answers `GET /v1/models`
for a tool-less backend that advertises nothing, and
`BRO_PROVIDER_TIMEOUT_MS` sets the per-call deadline (default 120000).
An unset backend falls back to the proxy; a misnamed or non-`acp`
entry is a loud startup error, never a silent proxy.

**The conductor path is session-grade.** Every `POST /v1/messages`
opens a real agent session — `session/new` plus the client's own
session-start hooks. A conversation turn can afford seconds; a
client's *internal* model calls cannot. An interactive client must
point its internal models — the auto-mode permission/safety
classifier and the small/fast background model (claude-code's
`ANTHROPIC_SMALL_FAST_MODEL`) — at a direct `api`-kind endpoint: the
byte-proxy mode above, or the real upstream. Routing them at the
conductor pays a session spin-up inside a seconds-scale permission
deadline, so every check fail-closes as "temporarily unavailable" and
each approval times out.

**Two permission layers, independent of each other:**

- *Conductor layer* — the hosted agent's `session/request_permission`
  (its native tools) is answered `deny`. The path has no interactive
  policy surface; the deny renders to the agent as a refusal — it is
  bro's policy, not a human's rejection.
- *Client layer* — the `tool_use` blocks that come back execute on the
  client's own tool surface, gated by the client's own permission
  machinery — the classifier that must live on a direct `api` provider
  per above.

**Tools bounce through the client.** The hosted agent carries no
native tools on this path: the client sends its tool definitions, the
conductor serializes them into the prompt, and the agent answers
`<tool_call>{json}</tool_call>`. Each call maps to an anthropic
`tool_use` block (`stop_reason: "tool_use"`); the client executes it
with its own tools and returns `tool_result` on the next request —
proved end to end by a live Bash echo round-trip (`ACP_BRIDGE_OK`).
