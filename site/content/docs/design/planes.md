---

title: Planes — one facade-out contract
description: A fixed catalog of domain planes with declared row types and verbs, served identically over REST, SSE and MCP — bro as a service over all agents.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

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

The contract is: every transport serves the same plane catalog — a new
consumer binds a transport, not a feature set. Today's surfaces ride
this axis but do not mount the whole catalog yet: `bro serve` exposes
bespoke routes (a snapshot endpoint plus an SSE tail over agent logs),
and the MCP endpoint fronts a tool list generated from the same
facades. The full REST/SSE plane surface — a route per plane resource —
is the facade work `bro-9rls` still specs; until it lands, planes.md is
the contract those bespoke endpoints are the first slices of.

`/ui`-style thin dashboards sit on this axis: read the planes, never
the internals.

**Sources:** `specs/bro-9rls.1.md` (facade-out contract, plane
catalog), `specs/bro-9rls.2.md`, the serve/mcp _(0.3.0)_ commands.
