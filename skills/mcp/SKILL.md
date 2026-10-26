---
name: mcp
description: "Use when an MCP-capable client (Windsurf, Zed, Goose, Gemini CLI, Copilot, Claude Desktop) should read bro orchestration state as tools instead of shelling `bro` and parsing text — `bro fleet mcp` is the stdio server over the read planes. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /mcp (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro fleet mcp` serves the plane catalog (`specs/bro-9rls.1.md`) over stdio MCP.
One server reaches every MCP-capable client — no per-client adapter.
Tools are generated from the plane descriptors, never hand-maintained:
`bro_<plane>_list` and `bro_<plane>_get` on every plane, plus one tool
per declared named read (`bro_work_ready`, `bro_queue_next`,
`bro_gates_status`, `bro_gates_threads`, `bro_agents_fleet`,
`bro_events_tail`, `bro_judge_stats`, `bro_debt_next`,
`bro_debt_summary`, `bro_learn_probe`).

**Read-only except spec-assigned verbs.** Write verbs stay unexposed
until a spec assigns one to this transport through the descriptor's
`mcpVerbs` allowlist — generation is the only path, so a verb cannot
become a tool by accident. The one wired verb today is
`bro_agents_delegate` (spec bro-z8tng — the same contract as
`bro fleet delegate`: `mode:'wait'` is a pooled ACP turn, `'detach'` a
registry spawn); `spawn`/`stop`/`respawn` remain declared-but-unwired.

## Registering

`bro fleet mcp` runs in the repo it should serve (the catalog is per-dir).
Point the client's MCP config at it like any stdio server:

```jsonc
{ "mcpServers": { "bro": { "command": "bro", "args": ["mcp"], "cwd": "<repo>" } } }
```

## Semantics the client can rely on

- `tools/list` is the discovery document: an absent capability means an
  absent *tool* — a repo with no review host exposes no `bro_gates_*`
  tools, a repo without beads no `bro_queue_*`/`bro_learn_*`.
- Tool results are JSON text. A plane whose backend is down returns
  `{ "error": "<degraded note>" }` (with `isError: true`) — degraded,
  never a stack trace, never a fake empty list.
- `get`/`exec` refs are the domain's stable keys — task id, agentId,
  mol id, `{gen}:{seq}`, thread_id.
- `mcp.planes` in bro.config.json narrows exposure: absent/empty `mcp`
  section = every read plane (spawning the server IS the consent),
  `[]` = none, a list = allowlist.

## Debug surface

| Command | What it does |
| ------- | ------------ |
| `bro fleet mcp --tools` | prints the generated `tools/list` payload for this repo (same capability gating a client sees) and exits |
