---

parent: bro-9rls
scope:
- packages/core/src/planes.ts
- packages/cli/src/planes/
- packages/cli/src/commands/mcp.ts
- packages/cli/src/commands/serve.ts
- packages/mcp/src/tools.ts
- packages/cli/src/commands/contract.ts
- contract/cli.json
- scripts/check-contract.ts

---

# bro-xiq2m — planes: parity check — every MCP/REST plane op maps to a CLI contract entry

Parent: `bro-9rls` (planes facade). Transports must stay adapters over the CLI/plane contract (owner decision). Without a parity check MCP/REST can grow ops the CLI lacks and the contract forks.

## Problem

Planes expose operations via descriptors (reads, verbs) and transports project them identically: MCP generates tools as `bro_<plane>_<read>` / `bro_<plane>_<verb>` (for mcpVerbs), REST serves `GET /api/v1/planes/<p>[/<name>]` and `POST /api/v1/planes/<p>/<verb>`. The CLI surface is tracked separately by `bro contract` (contract/cli.json) — the machine-readable CLI contract. Today nothing enforces that every plane operation has a corresponding CLI contract entry. A plane/transport can grow operations that aren't represented in the CLI contract, causing the contract to fork from the plane/transport surface.

## Design

### The mapping

Every plane operation must map to a CLI contract entry. Define the mapping:
- A plane's named read `read(name)` exposed via transports corresponds to CLI affordance for that plane/read.
- A plane verb exposed via transports (MCP verb in mcpVerbs, or any verb that REST/MCP exposes) must correspond to a CLI contract entry.

We need a parity check: enumerate all plane ops from the catalog (reads + mcpVerbs/exposed verbs across all registered planes) and assert each has a corresponding CLI contract entry. The CLI contract is the committed `contract/cli.json` plus the dump.

### Implementation

Add a parity check function. Options:
1. Add to `bro contract check` — extend the existing contract gate to also verify plane parity.
2. Add a separate check script (e.g. `scripts/check-plane-parity.ts`) and wire into CI/package.json.
3. Add to `scripts/check-contract.ts` or create a new check integrated into tests.

The task says "verify like CI before opening the PR" - probably need to add a check that runs in CI. Let us look up how checks are done. Also look up package.json - there's `check:contract` already. Maybe add `check:planes` or extend `check:contract`?

Also look up the full picture of tests - maybe add a test for parity. Let us look up existing patterns.

### Contract entries for plane ops

Need to define what counts as a "CLI contract entry". The CLI contract (`contract/cli.json`) is built from registry plugins via `bro contract dump`. Each plugin/command has entries in the contract. Planes are not CLI commands - they're a different abstraction (served by `bro serve` and `bro mcp`). But the requirement says "every MCP/REST plane op maps to a CLI contract entry" - so there must be CLI commands/contract entries that correspond to accessing/manipulating those plane operations.

Alternatively, maybe each plane operation must have a corresponding CLI command? Let us look up how planes are consumed. For example, `bro fleet` relates to agents plane, `bro status`/work plane operations, etc. Or maybe the CLI contract needs to include plane operation mappings.

Alternatively, looking up the architecture again: "planes declare what bro serves a client. Transports (REST, SSE, MCP) are generated projections of this catalog" and "Transports must stay adapters over the CLI/plane contract (owner decision). Without a parity check MCP/REST can grow ops the CLI lacks and the contract forks."

So the CLI contract (the command contract) is the source of truth - transports must be adapters over it. That means plane operations must derive from/match CLI contract entries. So we need to enforce that mapping.

Let us look up the codebase more. Also look up how others interpret this - maybe look up similar naming in specs. Also look up bro-9rls more - the planes are facades out of bro; CLI commands are the primary interface. Maybe each plane op needs to be exposed via CLI commands and tracked in the CLI contract?

Alternatively, let us look up the full test expectations by looking up how tests might expect this. Let us search more.
