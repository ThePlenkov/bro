---
parent: bro-l8c4f
scope:
  - packages/core/src/providers.ts
  - packages/core/src/config.ts
  - packages/core/src/schema-validator.ts
  - packages/cli/schemas/bro.config.schema.json
  - packages/providers/src/acp-worker.ts
  - packages/providers/src/acp-worker.test.ts
  - packages/cli/src/commands/acp-worker.ts
  - packages/cli/src/agent-connectors/core.ts
  - packages/core/src/agents.ts
  - packages/cli/src/planes/planes.test.ts
  - site/content/docs/commands/providers.md
  - site/content/docs/configuration.md
---

# bro-l8c4f.14 — Опционально передавать read-only MCP servers в ACP worker sessions

Parent: `bro-l8c4f` (principal audit 2026-10-18 — acp-mcp).

## Problem

Every ACP worker session opened with `mcpServers: []` — an ACP-spawned
fixer ran tool-blind, with no access to the same board/fleet/tasks
read planes an interactive agent reaches through the `bro mcp` stdio
server. ACP `session/new` accepts MCP server descriptors; the worker
never sent any.

## Contract

Opt-in, per-provider, merged config only (`providers.<name>.mcpServers`
on an `acp` entry — local > project > global merge applies as for every
entry key). Absent/empty stays `[]` — no behavior change without
explicit config.

- **Descriptor shape** — stdio only in this iteration:
  `{ type?: 'stdio', name, command, args: string[], env?: [{name,
  value}] }`, the ACP `McpServerStdio` wire shape. `name`, `command`,
  `args` are required (wire-required); `env` defaults to `[]` at
  validation so a strict agent never silently drops the entry.
  HTTP/SSE/ACP-transport descriptors are rejected with remediation
  text — they are admitted only when the session negotiates the
  capability, which the headless worker does not wire.
- **Validation boundary** — the provider parser fails loud naming the
  bad key (`mcpServers[i].command must be a non-empty string`); the
  worker re-validates the same shape before `session/new` so a bad
  descriptor dies as a config error, not an opaque session-start
  failure. Diagnostics never echo `env`/header values.
- **Secret channel** — descriptors ride a 0600 artifact pinned by
  `BRO_MCP_FILE`, never argv: a stdio server's `env` credentials would
  be world-readable in `ps`/procfs. The spawn pin allowlist strips a
  caller-supplied `BRO_MCP_FILE` so the file path is never forgeable.
- **Client honesty** — the worker's `initialize` advertises
  `fs:false`/`terminal:false`; `fs/*`, `terminal/*`, `elicitation`, and
  `mcp/message` agent→client calls answer method-not-found. No generic
  MCP relay: the ACP agent connects to the listed servers itself.
- **Judge stays tool-less** — `providers` `mcpServers` applies to the
  spawn surface only; the judge path keeps `mcpServers: []` (the
  brokered conductor passthrough, spec bro-ymbq1, is the downstream
  client's own descriptor, not ours).
- **BRO read planes** — the recommended descriptor
  `{ "name": "bro", "command": "bro", "args": ["mcp"], "env": [] }`
  hands the worker the `bro mcp` plane catalog (narrow with
  `mcp.planes`). The MCP surface stays read-plane plus the one spec'd
  write (`agents.delegate`, bro-z8tng): `claim`/`resolve`/`spawn` verbs
  are never in `mcpVerbs` and stay capability-hidden — a regression pin
  asserts the qualified `plane.verb` allowlist is exactly
  `['agents.delegate']`.

## Acceptance criteria

- [x] Fake ACP peer receives the configured descriptor —
      `acp-worker.test.ts`: `fake.sessionRequests[0].mcpServers`.
- [x] Without opt-in the list stays empty — same test, second leg
      (`mcpServers` deep-equals `[]`).
- [x] Unsupported transport yields remediation guidance — `http`
      descriptor rejected naming `stdio descriptor` remediation;
      `providers.test.ts` covers the config-parse twin.
- [x] Broker does not advertise fs/terminal/relay — `initialize`
      sends `fs:false`/`terminal:false`; `UNADVERTISED_METHODS`
      (incl. `mcp/message`) answer method-not-found.
- [x] No secrets in diagnostics — `SECRET_TOKEN`/`Authorization`
      absent from log lines; a malformed JSON file errors
      `invalid JSON`, never echoing the parser's source slice;
      descriptors never reach argv (`agent-connectors.test.ts`).
- [x] BRO server still does NOT export claim/resolve/spawn writes —
      `planes.test.ts` pins the catalog's wired `mcpVerbs` — qualified
      `plane.verb` — to `['agents.delegate']`; `spawn`/`stop`/`respawn`
      stay declared-but-unwired (capability `false`).

## Non-negotiables

- Default stays EMPTY `mcpServers` — opt-in only.
- No secrets in argv/logs/diagnostics — env credential values are never
  printed.
- Grouped CLI + permanent flat aliases, one portable skills tree,
  existing facades preserved.
- Advisory/fail-open UX is not security enforcement — validation fails
  loud at parse, the 0600 file is the only descriptor channel.
