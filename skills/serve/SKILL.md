---
name: serve
description: "Use when a thin client (TUI, webui, IDE) needs the bro facade over HTTP — `bro serve` hosts the agents/fleet/snapshot planes as JSON on 127.0.0.1. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /serve (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0` (major-pinned), plus
`bd` — the snapshot route and a `{molStep}`-only spawn resolve through
the shared beads store.

`bro serve` hosts the agents facade plus the watch snapshot as HTTP/JSON
so TUI/webui/IDE clients are thin — they never shell out to `bd`/`gh`
themselves. The loopback bind IS the trust boundary: 127.0.0.1 only, no
`--host` flag, no remote exposure in v1. Writes are gated by a session
token — see below.

## Command

| Command | What it does |
| ------- | ------------ |
| `bro serve [--port N]` | Foreground server; default port is ephemeral. The bound URL is printed and written to `<git-common-dir>/bro/serve.json` (mode 0600) — that file is how clients discover the endpoint AND the session token |

## Routes

| Route | What it returns |
| ----- | --------------- |
| `GET /` | service index — `{service, routes}` |
| `GET /fleet` | the fleet webui — an HTML dashboard that polls `/api/v1/snapshot` (read-only; opens in a browser) |
| `GET /api/v1/health` | `{ok, pid, dir, startedAt}` — liveness |
| `GET /api/v1/snapshot` | the `bro watch` snapshot — mols × gates × fleet |
| `GET /api/v1/agents` | per-backend agent plane (`bro agents status --json` shape) |
| `GET /api/v1/agents/<ref>` | one agent; ref is agentId or molStep |
| `POST /api/v1/agents` | spawn — `{molStep, worktree?, prompt?\|promptFile?, connector?, beadsDir?}` → `201 {agent}`; writes MUST send `Authorization: Bearer <token>` (the `token` field in serve.json — `401` without it) and `content-type: application/json` (loopback CSRF guard — a body-bearing write without it is `415`); `409` on a claim conflict (live agent, foreign claim/backend), `400` on bad input (unknown field, missing worktree, unsafe name), `503` when the backend tooling is missing/down, `500` on server misconfiguration (e.g. no agent command configured) |
| `DELETE /api/v1/agents/<ref>` | stop — `200 {agent, stopped, terminal?}`; `401` without the bearer token, `404` on a clean miss, `503` when a degraded backend makes the miss unverifiable |
| `POST /api/v1/webhooks/github` | GitHub webhook ingest → `github:*` bus topics (spec `specs/bro-huy5o.7.md`). The `X-Hub-Signature-256` HMAC is the auth — NOT the session token, and the loopback-Host guard is bypassed so a hosted tunnel's public Host still reaches it. Armed only while `BRO_GITHUB_WEBHOOK_SECRET` is set (unset → `503`, bad/missing signature → `401`, verified → `202 {accepted, published}`); when armed, `bro serve` also hosts the repo broker in-process |

## Policy

- **Discovery is the state file, not a port convention.** Read
  `<git-common-dir>/bro/serve.json` for `{pid, url, token}` — the default
  port is ephemeral so two repos can serve without colliding. A second
  `bro serve` on one repo refuses while the recorded pid is alive.
- **Writes require the session token.** Every POST/PUT/PATCH/DELETE must
  send `Authorization: Bearer <token>` where the token is the `token`
  field in serve.json — possession, not UID, is what the server checks.
  The file is written mode 0600, so the token is normally readable only
  by its owner: a different local user without the token gets 401 and a
  browser can't send the header cross-site. Reads don't take it — any
  local user can reach the GET planes over loopback (v1 accepts this;
  the gated surface is mutation, and the planes expose repo state the
  owner's own processes can read from disk anyway). The ONE exception
  is `/api/v1/webhooks/*` — ingest routes authenticate on the delivery's
  HMAC signature instead and deliberately skip the Host guard so a
  public tunnel can forward into them.
- **Writes exist because the host is local.** spawn/stop ride the same
  claim/registry machinery as `bro agents up|down` — dedup, respawn, and
  beads-claim semantics are identical. Remote orchestration is a
  separate spec; never widen the bind.
- **Read planes degrade, they don't die.** A failed backend contributes
  `degraded` notes inside the payload — a client must render them, not
  assume the fleet is empty.
- **Foreground process.** `bro serve` is a deployment's child — run it
  under whatever supervisor owns the session; ctrl-c/SIGTERM closes the
  listener and clears serve.json.
