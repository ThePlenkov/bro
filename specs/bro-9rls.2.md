---
parent: bro-9rls.1
scope:
  - packages/core/src/planes.ts
  - packages/core/src/config.ts
  - packages/cli/src/planes/
  - packages/cli/src/commands/mcp.ts
  - packages/cli/src/commands/fleet.ts
  - packages/mcp/
  - skills/mcp/SKILL.md
---

# bro-9rls.2 — planes: `bro mcp`, a stdio MCP server over the read planes

Parent: `bro-9rls.1` (planes facade spec) — this is milestone 6, the
MCP transport, plus the plane catalog it generates from.

## Problem

An agent that wants orchestration state — what's gated, what's ready,
what the fleet is doing — shells a different `bro` verb per question
and re-parses the output every session. Every MCP-capable client
(Windsurf, Zed, Goose, Gemini CLI, Copilot, Claude Desktop) already
speaks one protocol; serving the plane catalog over stdio MCP reaches
all of them with zero per-client adapters — and because tools are
*generated* from plane descriptors, the tool surface cannot drift from
what the CLI actually does (the spec's descriptor-drift control).

## Design

### `bro mcp` — the transport

`packages/mcp` (`@broject/mcp`) carries the SDK binding —
`@modelcontextprotocol/sdk` 1.31.x, dynamic `import()` inside
`serveMcp`, so a repo that never runs `bro mcp` never loads it.
`tools/list` and `tools/call` are the only handlers; generation and
dispatch are SDK-free in `tools.ts` so they unit-test without a
transport.

- **Tools are generated, never authored** — `bro_<plane>_list` and
  `bro_<plane>_get` on every plane, `bro_<plane>_<read>` per declared
  named read. `tools/list` re-probes `capabilities()` per call;
  `read: false` (or a probe that throws) hides the plane's tools —
  absent capability = absent tool.
- **Failures land as `{ error }` tool results** — `isError: true` with
  the degraded note as text. A caller never gets a stack trace.
- **v1 is read-only** — declared verbs stay unexposed (`verbsNotWired`
  makes a declared verb `PlaneUnavailable`, an undeclared one
  `PlaneVerbError`) until the spec's session-authz question is settled.
- `bro mcp --tools` prints the generated `tools/list` and exits — the
  debug surface, identical gating to a client's view.

### The catalog it serves

`packages/core/src/planes.ts` holds `PlaneDescriptor`, the row types,
`PlaneVerbError`/`PlaneUnavailable`, and a `registerPlane`/`planes(dir)`
registry parallel to `facade()`. Adapters live in
`packages/cli/src/planes/` because the machinery they project lives in
cli — each is a thin projection over existing `collect*`/facade
functions, never a second source of truth.

The spec's catalog is seven planes; `learn` ships as the eighth because
this bead names `learn probe` — descriptor-generated like the rest,
no transport special-casing. `agents` adds a `fleet` named read
(`collectFleet`) for the bead's fleet requirement.

| plane  | reads                | rows from                              |
| ------ | -------------------- | -------------------------------------- |
| work   | ready, status        | `tasksAsync` store + `collectStatus`   |
| agents | backends, fleet      | `collectAgentBackends`, `collectFleet` |
| queue  | next                 | convoy `listMolecules`/`nextStep`      |
| gates  | status, threads      | reviewHost + `evaluateExitGate`        |
| events | tail                 | bus ring probe + mailbox (listed, not drained) |
| judge  | stats                | verdicts journal + `computeStats`      |
| debt   | next, summary        | `readDebtRecords` + `buildSummary`     |
| learn  | probe                | `listLessons`/`probeQuestion`          |

### Config — `mcp` section

`bro.config.json` gains `mcp.planes`: absent/empty section = every read
plane (spawning the server IS the consent), `[]` = none, a list =
allowlist. Backend selection stays on `connectors.*` — config picks
which planes are *exposed*, never which exist.

## Non-negotiables (inherited from bro-9rls.1)

- One contract, N transports — a tool that differs from the REST read
  is a descriptor bug.
- Vocabulary at the type boundary — rows carry plane nouns only;
  `backend` is a value, never a field name.
- Capabilities are probed — `tools/list` is a live document, not a
  config echo.
- Writes keep their boundary — no verbs until session-ownership authz
  is designed.

## Plan

1. Core: `planes.ts` contract + registry, `mcp` config section.
2. `packages/cli/src/planes/*` — eight adapters over existing machinery.
3. `packages/mcp` — tool generation (pure) + stdio server (lazy SDK).
4. `packages/cli/src/commands/mcp.ts` — entry, `--tools`, `mcp.planes`
   allowlist.
5. `skills/mcp/SKILL.md` — registration + client semantics.
6. Tests: unit (`tools.test.ts`, `planes.test.ts` in core and cli) +
   e2e (`mcp.e2e.test.ts` — newline JSON-RPC over the built CLI:
   initialize → tools/list → tools/call, allowlist/disable).
