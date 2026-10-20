---
name: provider
description: "Use when Claude Code should run ON bro — `bro provider serve` is the host-level Messages-API listener (ANTHROPIC_BASE_URL target), `bro provider ensure` self-starts it, and `bro provider url|token|env` are the one-time wiring helpers. Thin wrapper over the bro CLI — mechanics live in the CLI."
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

- **host listener** — `bro provider serve`: user-scoped, repo-free,
  bound to the well-known port **4545** by default. Exactly one per
  provider state directory — `provider.json.lock` enforces it. The
  permanent wiring.
  State at `$XDG_STATE_HOME/bro/provider.json` (0600). There is **no
  dedicated start step** — `bro provider ensure` (the apiKeyHelper)
  resolve-or-spawns it on demand.
- **repo serve** — `bro serve`: the facade host; wires `/v1/*` too when
  the server env carries an upstream key (`serve.json` records
  `provider: true`). Repo-scoped, ephemeral port — the fallback and
  the per-run-port escape hatch (explicit `ANTHROPIC_BASE_URL` pin),
  not the everyday endpoint.

The `/v1` plane itself is whichever plane is configured: a `serve.backend`
/`providers.<name>` acp conductor (read from the **global** config layer —
the spawning repo's config never leaks into a machine-level service) or
the env-key byte-proxy to `BRO_PROVIDER_UPSTREAM` (default
api.anthropic.com) with `BRO_PROVIDER_API_KEY`.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro provider serve [--port N]` | Foreground host listener on 127.0.0.1 (default 4545). Refuses while another listener is live in the same provider state directory and when nothing is configured to serve (no `serve.backend`/`providers.*` in global config, no upstream key in env). Rarely invoked by hand — `ensure` spawns it. |
| `bro provider ensure [--port N]` | Resolve-or-spawn the host listener, print the session token — **the apiKeyHelper**. Probe → detached spawn → poll → token on stdout; failures exit 1 on stderr. |
| `bro provider url` | Print the endpoint `ANTHROPIC_BASE_URL` should point at |
| `bro provider token` | Print the session token — self-heals through the ensure path on a dead listener, same helper contract |
| `bro provider env` | Print `export ANTHROPIC_BASE_URL=…` + `export ANTHROPIC_AUTH_TOKEN=…` — `eval "$(bro provider env)"`-able; a comment carries the settings.json block |
| `bro provider env --json` | Print the `~/.claude/settings.json` block verbatim — `{"env":{"ANTHROPIC_BASE_URL":…},"apiKeyHelper":"bro provider ensure"}` |

## Resolution — cwd-aware

`url`/`token`/`env` all pick the same endpoint:

1. `ANTHROPIC_BASE_URL` set in env → exact url match (localhost,
   default port, and trailing slash normalized — **the path must
   match too**: a base carrying one never selects a listener that
   serves root-anchored `/v1/*`) against the live host listener, then
   the cwd repo's live serve — the helper tracks the client's actual
   target, never guesses;
2. unset → the live **host** listener — one gateway per provider state
   directory;
3. else the cwd repo's live serve **with the provider plane wired**;
4. else exit 1 — a wrong token is worse than a nonzero exit.

## The one-time wire

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4545" },
  "apiKeyHelper": "bro provider ensure"
}
```

in `~/.claude/settings.json` — nothing else, ever. The first auth
refresh after a boot spawns the listener; every claude (any repo, any
pane) flows through the same one. The token stays dynamic — the helper
resolves it per call from the live state file, so listener restarts
never stale the client.

## Trust boundary (same as serve)

Loopback bind only — 127.0.0.1, no `--host`. Every `/v1/*` request must
present the session token as `Authorization: Bearer` or `x-api-key`
(claude sends whichever its credential resolution produced); the 0600
state file means "can read the token" = same-UID local process.
Loopback `Host` and `Origin` checks keep browsers out.
