---
name: provider
description: "Use when Claude Code should run ON bro — `bro provider serve` is the host-level Messages-API listener (ANTHROPIC_BASE_URL target) and `bro provider url|token|env` are the one-time wiring helpers. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /provider (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

bro proxies the Anthropic Messages API: a claude pointed at a bro
listener talks to the configured upstream **through** bro — the proxy
owns auth (the client presents bro's session token; the upstream sees
the real credential from the server env), never the protocol. SSE
streams, tool_use, and `/v1/models` discovery all pass through
untouched.

Two planes produce an endpoint:

- **host listener** — `bro provider serve`: machine-level, repo-free,
  bound to the well-known port **4545** by default. The permanent
  wiring. State at `$XDG_STATE_HOME/bro/provider.json` (0600).
- **repo serve** — `bro serve`: the facade host; wires `/v1/*` too when
  the server env carries an upstream key (`serve.json` records
  `provider: true`). Repo-scoped, ephemeral port — for repo-local use.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro provider serve [--port N]` | Foreground host listener on 127.0.0.1 (default 4545). Refuses to start without `BRO_PROVIDER_API_KEY` (or `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`) in env, and while another listener is live — one per host. `BRO_PROVIDER_UPSTREAM` picks the Messages endpoint (default api.anthropic.com) |
| `bro provider url` | Print the endpoint `ANTHROPIC_BASE_URL` should point at |
| `bro provider token` | Print the session token — the `apiKeyHelper` contract: token alone on stdout, failures exit 1 on stderr |
| `bro provider env` | Print `export ANTHROPIC_BASE_URL=…` + `export ANTHROPIC_AUTH_TOKEN=…` — `eval "$(bro provider env)"`-able; a comment carries the settings.json block |
| `bro provider env --json` | Print the `~/.claude/settings.json` block verbatim — `{"env":{"ANTHROPIC_BASE_URL":…},"apiKeyHelper":"bro provider token"}` |

## Resolution — cwd-aware

`url`/`token`/`env` all pick the same endpoint:

1. `ANTHROPIC_BASE_URL` set in env → exact url match (localhost and
   trailing-slash normalized) against the live host listener, then the
   cwd repo's live serve — the helper tracks the client's actual
   target, never guesses;
2. unset → the cwd repo's live serve **with the provider plane wired**;
3. else the live host listener;
4. else exit 1 — a wrong token is worse than a nonzero exit.

## The one-time wire

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4545" },
  "apiKeyHelper": "bro provider token"
}
```

in `~/.claude/settings.json` plus `bro provider serve` running once on
the host → every claude (any repo, any pane) flows through bro. The
token stays dynamic — `apiKeyHelper` resolves it per call from the live
state file, so listener restarts never stale the client.

## Trust boundary (same as serve)

Loopback bind only — 127.0.0.1, no `--host`. Every `/v1/*` request must
present the session token as `Authorization: Bearer` or `x-api-key`
(claude sends whichever its credential resolution produced); the 0600
state file means "can read the token" = same-UID local process.
Loopback `Host` and `Origin` checks keep browsers out.
