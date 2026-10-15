---
title: Planes — one facade-out contract
description: A fixed catalog of domain planes with declared row types and verbs, served identically over REST, SSE and MCP — bro as a service over all agents.
---

bro already answers every orchestration question — what's gated, who's
working, what's next — but each answer lives behind a different CLI
verb with its own output shape. Every thin client (TUI, IDE, MCP host,
another agent) re-implements the same reads and re-invents the same
degradation rules.

Planes fix the contract: a **plane** is one domain facade exposed to
clients — `work`, `agents`, `queue`, `gates`, `events`, `judge`,
`debt`. A plane is a contract — row type + verbs + capability flags —
not a table.

## Declared rows, translated at the boundary

A plane row is a declared type — `WorkItem`, `Worker`, `Run`, `Gate`,
`Event`, `Verdict`, `Finding` — translated from the internal machinery
(`TaskRow`, `AgentInfo`, gate snapshots, journal envelopes) at the
adapter boundary. A client never deserializes an internal type, so the
internals stay free to move.

## Transports are adapters

`bro serve` (REST + SSE for live tails), the MCP endpoint, and any
future surface serve the same catalog identically. A new consumer binds
a transport, not a feature set — there is no route-per-feature growth
and no tool list that drifts from what the CLI actually does.

This is the axis `bro serve`'s snapshot endpoint and the SSE log tail
already ride, and the one `/ui`-style thin dashboards sit on.

**Sources:** `specs/bro-9rls.1.md` (facade-out contract, plane
catalog), `specs/bro-9rls.2.md`, the serve/mcp commands.
