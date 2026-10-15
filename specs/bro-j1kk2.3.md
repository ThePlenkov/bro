# bro-j1kk2.3 — serve: SSE `GET /api/v1/agents/<ref>/log?follow`

Epic `bro-j1kk2` (next-major release) child. Follow-on of `bro-j1kk2.1`
(`bro fleet agents log <ref> --follow`, [#536](https://github.com/ThePlenkov/bro/pull/536)):
the same live tail over `bro serve`, so the webui/TUI gets agent output
without shelling out.

## Problem

`bro serve` already hosts the agents plane (`GET /api/v1/agents`,
`GET /api/v1/agents/<ref>`) as JSON snapshots. A thin client wanting a
live log must poll — stale, lossy mid-window, and wasteful. The CLI's
`followLog` poll loop (`agents.ts`) knows the file's loss shapes
(truncation → resync, remove → respawn note) — the endpoint reuses it,
it does not re-implement tailing.

## Contract

`GET /api/v1/agents/<ref>/log` with `<ref>` = agentId or molStep (same
resolver as `GET /api/v1/agents/<ref>`).

Query params:

- `lines=<n>` — replay bound, default the CLI's `DEFAULT_LOG_LINES`
- `follow` — keep the connection open as `text/event-stream` after the
  replay; absent → one-shot `text/plain` response (the non-SSE path)

Response:

- one-shot: `200 text/plain`, the last `lines` lines
- follow: `200 text/event-stream`; the replay lands as ordinary `data:`
  frames first, then live appends; `followLog` notes surface as
  `event: note` frames (`[log truncated — resyncing]`,
  `[log removed — watching for a respawn]`, `[log reopened]`)
- remote log ref (copilot `sessionUrl` etc.): `422` with the same
  wording as the CLI — "log is remote — <url>"
- unknown ref / missing log: `404`

## Security

Log payloads carry agent thoughts and can contain secrets — the route
is **write-guarded, not read-guarded**: `Authorization: Bearer <token>`
(the serve.json session token, mode 0600) is required. For EventSource
clients (browsers can't set headers on SSE), `?token=<token>` is the
accepted fallback — constant-time compare, documented as
loopback-dev-server-grade, never logged. The 127.0.0.1 bind is the
transport boundary; the token is the auth boundary.

## Non-goals

- No auth surface redesign, no per-agent ACLs.
- No remote-log proxying — remote refs are named, not tailed.
- No new deps — `text/event-stream` is `data:`/`event:` frames over the
  existing `node:http` response.

## Test plan

- one-shot returns tail-N lines and 404/422 shapes
- follow streams replay then an appended line; a `note` event fires on
  truncate/remove/reopen
- missing/foreign token → 401; `?token=` fallback accepted
- `bro serve` route table test lists the route
