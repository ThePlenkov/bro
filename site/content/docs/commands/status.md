---
title: bro status + bro serve
description: The compact live board in one read, and the loopback HTTP facade for thin clients.
---

## `bro status`

One read returns everything a thin client (pi extension, TUI, dashboard)
needs per refresh tick — active beads, fleet workers, the drill frame,
git state — where N shell calls per tick used to be the only way. All
state is read, never mutated; bead-less or registry-less checkouts still
answer, with the absent sections empty or null.

| Command | What it does |
| ------- | ------------ |
| `bro status` | Compact human board — beads, fleet, drill, git |
| `bro status --json` | The same board, machine-readable — the thin-client contract |
| `bro status --deep` | Plus the act exit gate for the current branch's PR (network — the fast path stays local-only) |

Sources: `bd` (in-progress + ready, capped), the shared agent registry
(`<git-common>/bro/agents.json` — shared across linked worktrees), the
drill stack, git porcelain.

## `bro serve`

`bro serve [--port N]` is the write-capable counterpart: a foreground,
loopback-only HTTP/JSON facade so thin clients never shell out to
`bd`/`gh` themselves. The 127.0.0.1 bind is the trust boundary — no
`--host` flag. The bound URL and session token are printed and written
to `<git-common-dir>/bro/serve.json` (mode 0600); every mutation
requires `Authorization: Bearer <token>`.

| Route | Purpose |
| ----- | ------- |
| `GET /` | Service index |
| `GET /fleet` | Fleet web UI |
| `GET /api/v1/health` | Liveness |
| `GET /api/v1/snapshot` | Watch snapshot |
| `GET /api/v1/agents` | Agent plane |
| `GET /api/v1/agents/<ref>` | One agent by ID or molecule step |
| `POST /api/v1/agents` | Spawn an agent |
| `DELETE /api/v1/agents/<ref>` | Stop an agent |
