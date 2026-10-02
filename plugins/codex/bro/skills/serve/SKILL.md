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
`--host` flag, no remote exposure in v1.

## Command

| Command | What it does |
| ------- | ------------ |
| `bro serve [--port N]` | Foreground server; default port is ephemeral. The bound URL is printed and written to `<git-common-dir>/bro/serve.json` — that file is how clients discover the endpoint |

## Routes

| Route | What it returns |
| ----- | --------------- |
| `GET /` | service index — `{service, routes}` |
| `GET /api/v1/health` | `{ok, pid, dir, startedAt}` — liveness |
| `GET /api/v1/snapshot` | the `bro watch` snapshot — mols × gates × fleet |
| `GET /api/v1/agents` | per-backend agent plane (`bro agents status --json` shape) |
| `GET /api/v1/agents/<ref>` | one agent; ref is agentId or molStep |
| `POST /api/v1/agents` | spawn — `{molStep, worktree?, prompt?\|promptFile?, connector?, beadsDir?}` → `201 {agent}`; `409` on any spawn refusal (`SpawnError` — live claim, foreign backend, connector can't spawn), `400` on bad input, `415` when the body isn't `application/json` (loopback CSRF guard) |
| `DELETE /api/v1/agents/<ref>` | stop — `200 {agent, stopped}`; `404` on a clean miss, `503` when a degraded backend makes the miss unverifiable |

## Policy

- **Discovery is the state file, not a port convention.** Read
  `<git-common-dir>/bro/serve.json` for `{pid, url}` — the default port
  is ephemeral so two repos can serve without colliding. A second
  `bro serve` on one repo refuses while the recorded pid is alive.
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
