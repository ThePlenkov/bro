---
parent: bro-om6m8
scope:
  - packages/cli/src/commands/provider.ts
  - packages/cli/src/commands/serve.ts
  - packages/cli/src/commands/serve-provider.ts
  - packages/cli/src/plugins.ts
  - skills/provider/SKILL.md
---

# bro-om6m8.1 — provider env/token helpers + the host-level listener

Parent: `bro-om6m8` (epic — bro as a Claude Code provider). PR #495
shipped the `/v1/*` byte-proxy inside `bro serve`; this bead makes it
wirable ONCE for every claude on the machine.

## Problem

The provider plane works today only through a repo-scoped `bro serve`:

- the port is **ephemeral** — printed and written to
  `<git-common>/bro/serve.json` at bind time. `claude` settings take
  static env values only, so `ANTHROPIC_BASE_URL` can name no stable
  URL; every serve restart re-points the client.
- the session token is **per-run** — regenerated each serve, so a
  settings.json `apiKeyHelper` must resolve it dynamically; no helper
  exists.
- the state file is **repo-scoped** — the wiring dies at the repo
  boundary. A spawner that runs claude panes across repos (herdr)
  would need one settings file per repo.

Result: a user who wants "every claude pane through bro" cannot write
it down — the endpoint and the credential are both moving targets.

## Terms

- **provider endpoint** — one listener `{url, token}` a claude client
  can authenticate to. Two planes produce one: a repo `bro serve`
  (`<git-common>/bro/serve.json`) and the host-level `bro provider
  serve` (`$XDG_STATE_HOME/bro/provider.json`).
- **host listener** — the machine-level provider plane: one `bro
  provider serve` bound to a **well-known port**, state under the XDG
  state dir (same anchor as the user-level notify mailbox), repo-free.
- **cwd-aware resolution** — the helpers' pick order: the repo's own
  live provider serve when cwd is inside one, else the host listener.
  `ANTHROPIC_BASE_URL`, when set, pins the pick by exact url match —
  the apiKeyHelper always agrees with the URL the client will call.

## Decisions

- **`bro provider serve [--port N]`** is the host listener — picked
  over `bro serve --provider-only`: a separate command owns a separate
  state file and a separate lifecycle, so the repo facade and the
  machine plane never fight over serve.json. Default port is the
  well-known **4545** (`--port 0` still allowed for tests); nothing
  else in the fleet binds it. Requires the upstream credential in env
  at start — a provider-only host with nothing to proxy is refused,
  not 404-on-every-request.
- **One state shape, two files.** `provider.json` reuses the
  `serve.json` record `{pid, url, dir, startedAt, token}` at mode 0600
  under `$XDG_STATE_HOME/bro/` (tmp+rename, pid-matched cleanup, a
  `.lock` singleton on the same `holdFileLock` machinery) — the trust
  model is unchanged: reading the file means same-UID, possession IS
  the credential.
- **`serve.json` gains `provider: true`** when the repo serve wired the
  `/v1/*` plane. Resolution skips facade-only serves — `bro provider
  url` must never print an endpoint whose `/v1/*` 404s.
- **`bro provider url|token|env`** resolve the endpoint cwd-aware:
  1. `ANTHROPIC_BASE_URL` set in env → exact url match against the
     live host listener, then the cwd repo's live serve — the helper
     tracks the client's actual target, never guesses;
  2. unset → the cwd repo's live serve **with `provider: true`**;
  3. else the live host listener;
  4. else exit 1 (an apiKeyHelper that prints a wrong key is worse
     than one that fails).
- **`env` output is eval-able**: `export ANTHROPIC_BASE_URL=…` and
  `export ANTHROPIC_AUTH_TOKEN=…` plus a comment carrying the
  settings.json block; `--json` prints that block verbatim —
  `{"env":{"ANTHROPIC_BASE_URL":…},"apiKeyHelper":"bro provider token"}`
  — the one-time wire the bead contracts.
- **`/v1/models` stays pass-through.** Claude Code's gateway model
  discovery queries `GET /v1/models` on the base URL; the byte-proxy
  already forwards it credentialed to the upstream, so the picker lists
  whatever the upstream serves. No model list config in v1 — the proxy
  owns auth, not the protocol.
- **The repo `bro serve` keeps the facade.** The host listener serves
  `GET /`, `GET /api/v1/health`, and `ALL /v1/*` behind the identical
  guard stack (loopback Host → session token via Bearer OR x-api-key →
  loopback Origin → json content-type on body-bearing methods). No
  snapshot/agents/spawn planes — a thin host, not a second facade.

## User-facing contract

One block in `~/.claude/settings.json`, forever:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4545" },
  "apiKeyHelper": "bro provider token"
}
```

plus `bro provider serve` running once on the host. Every claude —
any repo, any pane — then flows through bro; per-repo `bro serve` still
works for the facade and for repo-scoped provider wiring.
