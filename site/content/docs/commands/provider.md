---

title: bro fleet provider
description: Opt-in model transport — a loopback Messages-API plane Claude Code can run on. Separate from the workflow it serves.
---

`bro fleet provider` (alias `bro provider`) hosts a Messages-API listener
so Claude Code can run on bro. Use `provider serve` to start the host,
and the wiring helpers to point clients at it. The listener binds to
127.0.0.1 only.

**The provider plane is opt-in transport.** The
`task → agent → PR → gate → debt` wedge — `bro review act`, `bro review
debt` — resolves no provider, starts no listener, and reads no upstream
credential. Nothing on this page is required to run the gate or sweep
the ledger.

## Three separate concerns

bro layers these deliberately — each is configured independently, and
each is absent until opted into:

| Concern           | What it is                                      | Where it lives                                                                               |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Mechanics         | The workflow contract — claim, work, gate, debt | [`bro review act`](/docs/commands/act), [`bro review debt`](/docs/commands/debt), the ledger |
| Execution backend | Where a worker's process runs                   | Fleet `agents.<backend>` connectors, `acp`/`cli` provider spawn entries                      |
| Model transport   | How model calls reach a model                   | This page — the [`providers` registry](/docs/commands/providers) and the `/v1/*` plane       |

A consumer opts in per layer: `judge.provider` names a registry entry for
thread annotation, a fleet profile names a spawn entry for workers, and a
Claude client opts into this listener by pointing `ANTHROPIC_BASE_URL` at
it. Absent the opt-in there is no transport — the listener stays unwired
and a missing provider name is a startup error, never a silent fallback.

## Commands

| Command                               | What it does                                     |
| ------------------------------------- | ------------------------------------------------ |
| `bro fleet provider serve [--port N]` | Start the Messages-API host listener             |
| `bro fleet provider url`              | Print the base URL to configure clients          |
| `bro fleet provider token`            | Print/configure the auth token                   |
| `bro fleet provider env`              | Emit shell env to wire `ANTHROPIC_BASE_URL`/auth |
| `bro fleet provider ensure`           | Ensure the host is running                       |

## Mechanics — two planes, one endpoint

Two planes produce an endpoint a client can authenticate to:

- **host listener** — `bro fleet provider serve`: user-scoped, repo-free,
  bound to the well-known port **4545** by default (one per provider
  state directory). The permanent wiring — `bro fleet provider ensure`
  resolve-or-spawns it, so there is no dedicated start step.
- **repo serve** — [`bro fleet serve`](/docs/commands/status): the facade
  host; wires `/v1/*` too when the server env carries an upstream key.
  Repo-scoped, ephemeral port — the fallback and the explicit-pin
  escape hatch.

Wire Claude Code once, in `~/.claude/settings.json`:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4545" },
  "apiKeyHelper": "bro provider ensure"
}
```

The helper spawns the host listener on first need and self-heals it on
death; every claude (any repo, any pane) flows through the same one.

## Transport modes — proxy and conductor

Which engine answers `/v1/*` is fixed by the **server's** env, never the
client request:

| Mode      | Armed by                                                                                                                                           | What answers                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| proxy     | `BRO_PROVIDER_API_KEY` (falls back to `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`); `BRO_PROVIDER_UPSTREAM` overrides `https://api.anthropic.com` | A byte proxy — SSE frames, `tool_use` blocks, and the beta surface pass through untouched while the session token is swapped for the real upstream key |
| conductor | `BRO_PROVIDER_BACKEND=<name>` naming a `type: "acp"` [provider](/docs/commands/providers) entry                                                    | A conducted ACP session — the model is an agent, carrying claude-class models through the operator's existing agent auth with no Anthropic key         |

The conductor mounts Anthropic Messages plus the OpenAI dialects
(`/v1/responses`, `/v1/chat/completions`) over the same session plumbing;
the byte proxy is dialect-agnostic and forwards whatever the client
sends. Dialect details, the classifier fast lane, and per-lane knobs
live under [`bro fleet serve`](/docs/commands/status#provider-plane--proxy-and-conductor).

## Credential boundary

- **Two credentials, one swap.** The client presents the _session token_
  (`Authorization: Bearer` or `x-api-key`); the upstream sees the _real
  key_ from the server env. A client's `apiKeyHelper` output never
  crosses the boundary — possession of the 0600 state file
  (`serve.json` / `provider.json`) IS the credential, so the trust
  domain is same-UID local processes.
- **Config names a source, never a value.** `serve.apiKeyEnv` names the
  env var holding the key; registry entries do the same via `apiKeyEnv`
  / `apiKeyCommand` (a secret-store lookup). No config field holds a
  key — `apiKey` in config is a parse error, and an `apiKeyCommand`
  that smuggles a key value is refused.
- **Loopback + browser guards.** 127.0.0.1 bind only, no `--host`;
  loopback `Host`/`Origin` checks keep browsers out; `redirect:
  'manual'` on upstream fetches means a cross-origin redirect never
  carries the swapped key to a host it was not minted for.
- **Unauthenticated = unwired.** Every `/v1/*` request authenticates,
  GETs included — an unauthenticated call would spend the upstream key
  blind. With nothing configured to serve, `bro serve` leaves `/v1/*`
  at `404` like any unknown path and `bro provider serve` refuses to
  start — a half-configured provider is a miss, never a degraded
  proxy.

## Retention

- **State files** — `serve.json` (repo) and `provider.json`
  (`$XDG_STATE_HOME/bro/`) record `{pid, url, dir, startedAt, token}` at
  mode 0600. They are the only persistence the transport owns.
- **The byte proxy retains nothing** — request and response bodies
  stream through; nothing is buffered to disk or logged.
- **The conductor retains conversations in memory only** — a retained
  ACP session per conversation (10-minute TTL for anonymous keys, 60
  minutes for explicitly named `h:`/`probe:` sessions, pool cap 32) so
  a resent history feeds only its tail. Telemetry emits _metadata_
  (backend, model, token counts, durations, stop reasons) — never
  message content.
- **Session transcripts live outside bro** — conducted turns are real
  agent sessions; their history lands in the hosted agent CLI's own
  session storage and their disposal is governed by the lane's TTLs and
  dead-loop budgets. For fleet `acp` spawn entries, `sessionRm` names
  the cleanup template (e.g. `devin rm {sessionId} --force`).

## Approval boundary

- **The conductor denies, it never approves.** A hosted agent's
  `session/request_permission` is answered `deny` — that is bro policy,
  not a human's rejection, and the path carries no interactive policy
  surface.
- **Client tools are the client's.** `tool_use` blocks come back to the
  client and execute under _its_ permission machinery — the classifier
  that must live on a direct `api`-kind endpoint, not on this path.
- **`autoApprove` is a fleet spawn knob**, on `acp` provider entries for
  headless workers — unrelated to this listener.
- **Merge approval is the act gate's** — the transport approves nothing.
  A client session routed through bro gains no workflow authority.

## Why it exists — and stays separate

The plane is the local auth/transport seam: one listener holds the
upstream credential so N clients (panes, repos, tools) ride it without
each holding the key, and the client-visible token stays a revocable
local artifact. It is also the mount point future gateway features
(routing, catalog, policy) build on — which is exactly why it stays a
plane _beside_ the workflow: a capability you opt into, never a
dependency of the `task → agent → PR → gate → debt` core.
