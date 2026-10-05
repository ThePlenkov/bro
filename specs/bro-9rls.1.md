---
parent: bro-9rls
scope:
  - packages/core/src/planes.ts
  - packages/cli/src/planes/
  - packages/cli/src/commands/serve.ts
  - packages/cli/src/commands/webui.ts
  - packages/cli/src/commands/mcp.ts
  - packages/mcp/
  - skills/serve/SKILL.md
---

# bro-9rls.1 — planes: one facade-out contract, transports as adapters

Parent: `bro-9rls` (epic). Pinning the design before children decompose.

## Problem

bro already answers every orchestration question a thin client or an
agent could ask — `bro watch` snapshots mols × gates × fleet, `bro
agents` manages workers, `bro convoy` schedules molecules, `bro act`
runs the review gate, `bro debt` keeps the ledger, the notify mailbox
and the event broker (PR #237) carry live transitions. But each answer
is reached by shelling a different CLI verb and parsing its output —
the fleet webui already hand-binds `/api/v1/snapshot`, and an agent
wanting "what's gated" re-derives `bro act status` parsing per session.
Every new consumer (TUI, IDE, MCP host, another agent) re-implements
the same reads and re-invents the same degradation rules.

The orthogonal axis is already landed: bro-ribc.1's `providers` are
transports **into** model/agent services (call/spawn surfaces);
`FacadeMap` connectors are transports **into** external systems
(github/gitlab/beads). What's missing is the third axis — facades
**out of** bro: a fixed catalog of domain planes with declared row
types and verbs, served identically over every transport. Without it
`bro serve` grows a route per feature, the TUI grows a parser per
command, and MCP becomes a hand-written tool list that drifts from
what the CLI actually does.

## Terms

- **plane** — one domain facade exposed to clients: `work`, `agents`,
  `queue`, `gates`, `events`, `judge`, `debt`. A plane is a contract —
  row type + verbs + capability flags — not a table.
- **plane row** — the unit a list/get returns. Rows are *declared
  plane types* (`WorkItem`, `Worker`, `Run`, `Gate`, `Event`,
  `Verdict`, `Finding`), translated from domain machinery
  (`TaskRow`, `AgentInfo`, `ConvoyNext`, `WatchPrGate`, `BusEnvelope`,
  judge `Verdict`, `DebtRecord`) at the adapter boundary — a client
  never deserializes an internal type.
- **verb** — a state-changing plane operation named in plane
  vocabulary: `work.claim`, `agents.spawn`, `queue.done`,
  `gates.resolve`, `events.publish`, `judge.decide`, `debt.collect`.
  Verbs are uniform across transports — `POST /api/v1/<plane>/<verb>`
  and an MCP tool call are the same operation.
- **capability flag** — a per-plane boolean evaluated against the
  *live* backend at serve time: `canClaim`, `canSpawn`, `canStream`,
  `canDecide`. A flag reflects a probe, not config presence — a
  configured-but-dead backend reads `degraded`, not `capable` (the
  fleet `unknown`-not-`lost` rule). Absent capability = hidden panel /
  absent tool / 404 naming the plane — never an error, never a faked
  empty list.
- **transport adapter** — a projection of the plane catalog onto a
  wire: REST (exists), SSE (live stream), MCP (agent tools). The
  descriptor is the contract; transports carry no per-transport
  semantics — a verb that exists exists everywhere it is exposed.
- **thin client** — `/ui` dashboard, `fleet --live` TUI, IDE panels.
  Interchangeable consumers of the same plane reads; none owns logic.

## Model

```ts
/** The catalog entry — what a transport iterates. */
interface PlaneDescriptor {
  name: 'work' | 'agents' | 'queue' | 'gates' | 'events' | 'judge' | 'debt'
  /** named read projections beyond list/get — 'ready', 'next',
   *  'stats', 'tail', 'summary'. Every transport enumerates them:
   *  REST serves GET /<plane>/<read>, MCP emits bro_<plane>_<read>.
   *  A name not declared here cannot be a tool — generation, not
   *  convention, is the contract. */
  reads: string[]
  /** declared verbs, plane vocabulary only */
  verbs: string[]
  /** live-evaluated — presence means probed-capable, not configured */
  capabilities(): Promise<Record<string, boolean>>
  list(filter?: PlaneFilter): Promise<PlaneRow[]>
  get(ref: string): Promise<PlaneRow | undefined>
  /** a declared named read — every entry in `reads` resolves here */
  read(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** throws PlaneVerbError — client bug (bad args) vs
   *  PlaneUnavailable — the backend can't serve it now */
  exec(verb: string, args: Record<string, unknown>): Promise<PlaneRow | void>
}
```

`planes(dir)` in core returns the catalog — parallel to `facade()`
but the other direction: facades resolve which *system* serves a
capability; planes declare what *bro* serves a client. Each plane
implementation is a thin adapter over machinery that already exists —
no plane owns state:

| plane   | rows from                          | named reads              | verbs                              |
| ------- | ---------------------------------- | ------------------------ | ---------------------------------- |
| work    | `taskStore(dir)` list/ready/get    | `ready`                  | claim, close, reopen, note, create |
| agents  | `collectAgentBackends` / AgentInfo | —                        | spawn, stop, respawn               |
| queue   | `loadMolecule`/`nextStep` per mol  | `next` (ConvoyNext)      | pour, claim, done                  |
| gates   | `reviewHost` checks/threads per PR | `status`, `threads`      | resolve, reply, merge              |
| events  | `BusEnvelope` ring + notify drops  | `tail` (ring slice)      | publish                            |
| judge   | verdicts.jsonl rows (`Verdict`)    | `stats` (agreement)      | decide                             |
| debt    | `readDebtRecords` / `DebtSummary`  | `summary`                | collect, set                       |

`list`/`get` are on every descriptor — `reads` holds only the *named*
projections a plane adds on top (`bro act status`'s exit gate is
`gates.status`, `bro convoy next` is `queue.next`). A row-level read
that isn't a named projection stays `list`+`get`.

**Vocabulary rule — the hard contract.** Plane rows and verbs carry
plane nouns only. A client renders `worker.state: 'lost'`, never
"devin session"; `item.status`, never "bead"/"jira issue"; `gate`,
never "act". Backend identity survives exactly one place: an
opaque `backend: string` field on rows that need provenance
(`Worker.backend: 'native'`), always a *value*, never a field name or
a type. If a client would have to know what `bd` is to read the row,
the row is wrong.

**Honesty rules (all planes, all transports).**

- A plane whose backing read throws reports `{ error }` on its
  descriptor — `unavailable`, never a false empty list (the
  `molsError`/`fleet.error` precedent in `WatchSnapshot`).
- `capabilities()` probes, doesn't read config: `agents.canSpawn` is
  false while every connector's `list()` is degraded;
  `events.canStream` is false while the broker socket won't accept;
  `judge.canDecide` is false without a resolvable provider
  (bro-ribc.1's registry, or the synthesized legacy entry).
- Row `id`s are the domain's stable keys — bead id, agentId, mol id,
  `{gen}:{seq}`, `thread_id` — so `get`/`exec` refs match across
  transports and across broker restarts.

## Transports

### REST — `bro serve`, extended not redesigned

The serve host keeps its trust boundary verbatim (loopback bind,
`serve.json` Bearer token on writes, Origin/content-type/Host guards —
spec `sessions/bro-f4ot/spec.md`). The plane catalog adds:

```text
GET  /api/v1/planes              plane index — descriptors + live
                                 capabilities; THE discovery document
GET  /api/v1/<plane>             list — filter params per descriptor
GET  /api/v1/<plane>/<name>      named read when <name> ∈ descriptor's
                                 `reads`, else get(<ref>) — read names are
                                 plane-declared constants, so a shadowed
                                 ref is a spec-visible choice, not a bug
POST /api/v1/<plane>/<verb>      exec — JSON arg body, same write auth
```

Today's routes stay as aliases over the same machinery —
`GET /api/v1/agents` IS `GET /api/v1/agents` the plane,
`POST /api/v1/agents` is `agents.spawn`, `DELETE` is `agents.stop`,
`GET /api/v1/snapshot` keeps serving the composite watch document (it
remains the heartbeat's one-call read; per-plane routes are the
granular contract, both project the same `collect*` functions —
never parallel implementations that can drift).

### SSE — the events plane, live

`GET /api/v1/events/stream` — Server-Sent Events over the local event
broker (PR #237's `bus.ts`), not WebSocket: the stream is
server→client only, SSE carries `Last-Event-ID` resume natively, and
no handshake/frame layer is needed.

- Cursor: `BusCursor {gen, seq}` rides `Last-Event-ID` as
  `<gen>:<seq>`. A cursorless connect gets the
  `BUS_PROBE_LIMIT`-sized tail; a foreign `gen` or a cursor past the
  ring window gets one `gap` frame then live events — the client's cue
  to re-derive from the planes (the registry stays source of truth;
  the ring is a replay buffer, never the record).
- **Dual-write at the publisher**: `bro notify`/watch drops keep
  landing in the mailbox (the postTool drain is unchanged) AND publish
  a mirrored `BusEnvelope` (`topic: 'notify'`) when a live broker
  accepts — the mailbox stays the in-session delivery path, the bus
  becomes the live stream, and neither consumer changes when the
  broker is down.
- Slow consumers follow the broker's own rule — `SLOW_CONSUMER_BYTES`
  drops with a `gap` frame, never an unbounded buffer.
- SSE is a *read* — Host guard only, no token. It leaks nothing a
  `GET /api/v1/planes` doesn't already expose to a same-UID reader.

**AsyncAPI** — the events plane's channel/topic registry generates an
AsyncAPI 3.x document served at `GET /api/v1/events/asyncapi.json`.
Generated, not authored: the doc is a projection of the same topic
table the SSE adapter iterates, so a doc/event drift is impossible by
construction. WebRPC/gRPC stay out until a consumer needs them.

### MCP — bro as a server for its own fleet

`bro mcp` — a stdio MCP server (`@modelcontextprotocol/sdk` 1.32.x,
MIT — verified npm 2026-10-05; lazy import, a repo that never runs
`bro mcp` never pays for it). An agent registers it like any MCP
server and reads orchestration state as tools instead of shelling
`bro` and parsing text.

- **Tools are generated from descriptors** — `bro_<plane>_list` and
  `bro_<plane>_get` on every plane, `bro_<plane>_<read>` for each
  declared named read (`bro_work_ready`, `bro_queue_next`,
  `bro_gates_status`, `bro_events_tail`, `bro_judge_stats`,
  `bro_debt_summary`). An absent capability means an absent *tool* —
  agents enumerate `tools/list` and see only what this repo can serve.
- **v1 is read-only.** The trust argument is the same as serve's reads
  (the spawning principal is same-UID and could read the state anyway),
  but MCP's write-authz story (which session a tool call speaks for)
  is undesigned — verbs stay REST/CLI until a spec assigns ownership.
  The descriptor marks which verbs are mcp-eligible later; the
  transport's job then is exposure, not new semantics.
- Per-plane tool failures return the plane's `{ error }` shape as the
  tool result — an MCP caller gets `degraded`, never a stack trace.

## The thin client — `/ui`

`GET /ui` — one self-contained page on the serve host (the
`FLEET_PAGE` precedent: inline CSS/JS, no build step, CSP hashes,
`textContent` only, loopback Host guard). `/fleet` stays as the
existing single-purpose view; `/ui` is the plane dashboard:

- Panels render per `/api/v1/planes` entry — the index IS the layout
  contract. A capability-false plane renders its panel dimmed with
  the reason; an `error`-ed plane renders `unavailable`.
- MVP transport is the snapshot poll (chained `setTimeout`,
  `document.hidden` discipline — identical to `/fleet`); when
  `events.canStream` the page upgrades to the SSE stream and drops to
  polling on stream death. The poll→SSE upgrade is a client-side
  fallback ladder, not a server negotiation.
- Read-only v1. Verb buttons (`claim`, `resolve`) need the Bearer
  token, which the page cannot hold — the token lives in a 0600 file
  by design. Writes stay on real clients until an auth story is
  specced; this is the same call `/fleet` already made.

## Config

```jsonc
{ "serve": { "port": 7377 },
  "mcp":   { } }
```

- `serve` — existing knobs plus `port` pin. Absent = today's defaults.
- `mcp` — absent/empty section exposes every read plane (`bro mcp`
  being spawned IS the consent — same-UID, operator-chosen).
  `mcp.planes: []` disables all; an allowlist narrows exposure.
- **No plane enumeration in config.** The catalog is fixed — seven
  planes is the design, not a default set. Which *backend* serves a
  plane rides the existing selection surfaces (`connectors.tasks`,
  `connectors.reviews`, `agents.<backend>`, `judge.provider`,
  bro-ribc.1 `providers`) — config picks systems, never planes. A
  ninth plane is a spec revision, not a config key; the "0 disables"
  precedent applies to knobs, not to inventing planes.

## Where it lives

```text
packages/core/src/planes.ts         PlaneDescriptor, plane row types,
                                    PlaneVerbError/PlaneUnavailable,
                                    capability-flag evaluation, registry
packages/cli/src/planes/work.ts     adapters — each plane over its
packages/cli/src/planes/agents.ts   existing machinery (taskStore,
packages/cli/src/planes/queue.ts    collectAgentBackends, nextStep,
packages/cli/src/planes/gates.ts    reviewHost, bus client, verdicts,
packages/cli/src/planes/events.ts   readDebtRecords). cli/src because the
packages/cli/src/planes/judge.ts    machinery lives there — core holds the
packages/cli/src/planes/debt.ts     contract, never the implementations
packages/cli/src/commands/serve.ts  /api/v1/planes, generated per-plane
                                    routes, /ui, SSE route, asyncapi.json
packages/cli/src/commands/webui.ts  the /ui page document
packages/cli/src/commands/mcp.ts    `bro mcp` entry — stdio serve loop
packages/mcp/src/server.ts          @broject/mcp — SDK binding, tool
                                    generation from descriptors (lazy dep)
packages/core/src/config.ts         serve/mcp sections
```

One new package because the MCP SDK must be optional weight — same
reason `@broject/providers` exists: core carries types and the
registry, SDK bindings import lazily behind the command that needs
them.

## Non-negotiables

- **One contract, N transports.** A verb or row that differs by
  transport is a bug in the descriptor, not a feature of the
  transport. New plane = new rows on every transport in one edit.
- **Planes are projections.** Every plane reads through the same
  `collect*`/facade machinery the CLI commands use — a plane that
  re-reads beads behind `taskStore`'s back, or re-implements gate
  evaluation outside `bro act`'s exit gate, is a second source of
  truth. Snapshot and per-plane routes must agree because they share
  the read, not because they were reconciled.
- **Vocabulary is enforced at the type boundary.** A plane row field
  named `bead`, `jira`, `devin`, `bd`, `glab` is a spec violation a
  reviewer rejects on sight. `backend`/`provider` string *values* are
  provenance; nouns in the contract are leaks.
- **Capabilities are probed, never presumed.** Configured ≠ capable.
  A flag that reports true on a dead backend is worse than no flag —
  it's the `degraded`-as-`lost` lie one layer up.
- **Config stays user-owned.** No code path picks a serving backend
  the user didn't name through the existing selection surfaces; no
  defaults materialize planes or tools the operator didn't spawn
  (the `bro mcp` process) or start (`bro serve`).
- **Writes keep their boundary.** REST writes keep the
  serve.json-token gate; `/ui` stays read-only while it can't hold a
  credential; MCP ships no verbs until session-ownership authz is
  designed. Convenience never routes around the authorization story.

## Milestones

1. `bro-9rls.1` this spec.
2. Plane contract in core — descriptors, row types, capability
   evaluation, `planes(dir)`; `GET /api/v1/planes` index.
3. REST planes — work/queue/gates/debt list+get+verbs through the
   uniform write shape; agents routes rebased onto the descriptor
   (aliases preserved); snapshot unchanged.
4. `/ui` — poll-based dashboard over the plane index, hidden/dimmed/
   unavailable states honest.
5. SSE `/api/v1/events/stream` — bus-backed, cursor resume, gap→
   re-derive, notify dual-write, generated AsyncAPI doc.
6. `bro mcp` — stdio server, read tools generated from descriptors,
   `mcp` config section.
7. Judge plane deepens when bro-ribc.1's registry lands —
   `judge.decide` verb + provider-sourced `canDecide`.

## Risks named up front

- **Descriptor drift.** The failure mode is a transport hand-growing
  a field the descriptor doesn't declare — then MCP tools and REST
  rows diverge silently. Control: routes/tools are *generated* from
  descriptors; a hand-written route shape per plane is a review
  finding, not a shortcut.
- **Vocabulary creep through values.** `TaskRow.external_ref` carries
  `PROJ-123`; `AgentInfo.backend` carries `devin`. The rule binds
  field names and types, not data — but a UI that branches on
  `backend === 'devin'` has smuggled the noun back in. Consumers
  render capabilities, never vendor names.
- **Snapshot/plane divergence.** `/api/v1/snapshot` stays the
  heartbeat's composite read; if planes grow fresher data than the
  snapshot shows, clients will mistrust the heartbeat. Both project
  the same collectors — the constraint is structural, not cosmetic.
- **SSE over a dead broker.** Events is the only plane whose primary
  read is a live system, not a store. `canStream` false must hide the
  stream cleanly; a client that treats "no broker" as "no events" is
  the phantom-quiet bug in new clothes.
- **MCP tool surface rot.** Generated-from-descriptor is the control,
  but `tools/list` shape changes still ripple to every registered
  agent config — the tool names (`bro_<plane>_<read>`) are the API,
  versioned with the descriptor, never renamed casually.
- **Scope: seven planes is the spec.** The catalog is deliberately
  closed — an eighth plane (`learn`? `specs`?) is a spec revision with
  a consumer attached, not a drive-by registration. Same rule as
  bro-ribc.1's four closed provider kinds.
