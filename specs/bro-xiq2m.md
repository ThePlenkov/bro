---

parent: bro-9rls
scope:
- packages/core/src/planes.ts
- packages/cli/src/planes/
- packages/cli/src/commands/contract-parity.ts
- packages/cli/src/commands/contract-cli.ts
- packages/cli/src/commands/contract.ts
- packages/cli/src/commands/contract.test.ts
- packages/cli/src/planes/planes.test.ts
- skills/mcp/SKILL.md

---

# bro-xiq2m — planes: parity check — every MCP/REST plane op maps to a CLI contract entry

Parent: `bro-9rls` (planes facade). Transports must stay adapters over the CLI/plane contract (owner decision). Without a parity check MCP/REST can grow ops the CLI lacks and the contract forks.

## Problem

Planes expose operations via descriptors (reads, verbs) and transports project them identically: MCP generates tools as `bro_<plane>_<read>` / `bro_<plane>_<verb>` (for mcpVerbs), REST serves `GET /api/v1/planes/<p>[/<name>]` and `POST /api/v1/planes/<p>/<verb>`. The CLI surface is tracked separately by `bro contract` (contract/cli.json) — the machine-readable CLI contract. Today nothing enforces that every plane operation has a corresponding CLI contract entry. A plane/transport can grow operations that aren't represented in the CLI contract, causing the contract to fork from the plane/transport surface.

## Design

### The mapping — the catalog declares its CLI twin

Every plane operation must map to a CLI contract entry. `PlaneDescriptor` gains an optional `cli?: Record<string, string>` field — op name → plugin name in `contract/cli.json` (`'next'`, `'act'`, `'convoy'`…). The declaration lives on the descriptor because the catalog is the contract: a plane author adding a named read declares its CLI twin in the same edit, and a missing entry is visible in the one place a reviewer looks.

Current twins (from each read's own doc-comment equivalent):

| plane.op           | CLI contract entry |
| ------------------ | ------------------ |
| `work.ready`       | `next`             |
| `work.status`      | `status`           |
| `agents.backends`  | `agents`           |
| `agents.fleet`     | `fleet`            |
| `agents.delegate`  | `delegate`         |
| `queue.next`       | `convoy`           |
| `gates.status`     | `act`              |
| `gates.threads`    | `act`              |
| `events.tail`      | `bus`              |
| `events.lifecycle` | `bus`              |
| `events.activity`  | `watch`            |
| `judge.stats`      | `judge`            |
| `debt.next`        | `debt`             |
| `debt.summary`     | `debt`             |
| `learn.probe`      | `learn`            |

### The checked surface — reads ∪ mcpVerbs

The parity check enumerates `reads` and `mcpVerbs` — the ops a transport can actually serve. `verbs` outside `mcpVerbs` are declared-but-unwired: every transport path (MCP tool generation, REST `POST …/<verb>` gate, `exec`) dead-ends them in `PlaneUnavailable`/`PlaneVerbError`, so they serve nothing and need no twin. When a spec wires a verb it lands in `mcpVerbs` (or an equivalent exposure list) and the twin requirement applies. `list`/`get` are the universal read pair — identical shape on every plane — and stay out of the per-op map; their CLI twins are the same table/row commands the named reads use.

### The check — inside the contract gate

`planeParityProblems(catalog, live)` in `packages/cli/src/commands/contract-parity.ts` is pure: for each exposed op it reports a `breaking` problem at `planes.<plane>.<op>` when `cli[op]` is undeclared or names a command absent from the live dump's `commands` map. `cmdGate` appends the result after `reconcileContract`, so:

- `bro contract check` (CI step `check:contract` → `scripts/check-contract.ts`) fails on orphan ops — no new CI wiring.
- `bro contract gen` refuses — a missing twin is breaking, not stale; regenerating the file can never paper a forked surface.
- `--dump` fixtures get the same verdict — parity is judged against whatever surface is being checked.
- `breaking` (not `stale`/`ledger`) is the kind: a parity miss is fixed by code (declare the twin or add the command), never by regen or a BREAKING.md bullet.

Checking `live` rather than the committed file is sufficient: a mapped command that exists only live is already stale drift; a committed entry naming a deleted command is breaking drift. The catalog comes from `planes(process.cwd())` — `contract-cli.ts` imports `../planes/index.ts` for the registration side effect, so the module stays self-contained (the same seam `mcp.ts`/`serve.ts` use).

### The `--json` schema clause

The bead's "compatible --json schema (A2)" rides on bro-pbfdp's contract work, which seeded schemas for the agent-facing reads (`next`, `status`, `act.status`, `fleet`, `agents.status`, `debt.next`). Twins without a declared schema today (`convoy`, `bus`, `watch`, `judge`, `learn`) are pre-existing schema gaps, not parity violations — the parity gate checks existence of the contract entry; deepening it to schema-compatibility is follow-up debt once the `--json` surface is fully declared.

## Verify

- `npx tsx --test packages/cli/src/commands/contract.test.ts` — `planeParityProblems` unit coverage (unmapped op, absent twin, mcpVerbs enumerated, unwired verbs skipped) plus an `orphan` fixture plane failing `runContractCommand check` with exit 1 at `planes.orphan.zap`.
- `npx tsx --test packages/cli/src/planes/planes.test.ts` — the real catalog is parity-clean against `buildDump(PLUGINS, GROUP_META)` (the rot-guard: a new read/mcpVerb without a twin fails here before CI does).
- `npm run check:contract` stays green on the committed contract.
