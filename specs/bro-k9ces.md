---
parent: bro-6ptci
scope:
  - packages/core/src/plugin.ts
  - packages/cli/src/commands/contract.ts
  - packages/cli/src/commands/contract.test.ts
  - packages/cli/src/plugins.ts
  - scripts/check-contract.ts
  - scripts/gen-command-docs.ts
  - contract/cli.json
  - contract/BREAKING.md
  - package.json
  - .github/workflows/ci.yml
---

# bro-k9ces — `bro contract dump --json`: the machine-readable CLI surface

Parent: `bro-6ptci` (epic — the CLI is the agent contract). Unblocks
`bro-pbfdp` (--json output schemas, referenced from `contract/cli.json`),
`bro-mk7m2` (command index generated from the contract), `bro-tegz2`
(ACP slash commands routed over the contract).

## Problem

There is no single machine-readable statement of the CLI surface.
`plugins.ts` knows commands + skills + config sections, but flags, exit
codes and `--json` shapes live in each command's usage text — readable
only by opening source. Agents and transports (serve, mcp, ACP) have
nothing to read.

`bro plugins --json` comes closest, but it is a debug view of the
registry — no flags, no exits, no declared json shape — and nothing pins
the surface: a command can be renamed or dropped and only a human
reviewer notices.

## Design

### `contract` on the registry entry

`BroPlugin` gains an optional `contract` block (core/plugin.ts):

```ts
interface CliSubContract {
  flags?: Record<string, string>   // "--json" → one-line meaning
  exits?: Record<number, string>   // code → meaning (taxonomy: bro-1znlu)
  json?: string                    // schema ref — schemas/cli/<…>.schema.json
}
interface CliContract extends CliSubContract {
  subs?: Record<string, CliSubContract>  // per-subcommand — `act status` ≠ `act merge`
}
```

Top-level `flags`/`exits` describe the bare command; `subs` carry
subcommand-scoped surfaces. `json` is a REF — the schemas themselves are
bro-pbfdp's file drop; this bead only reserves the pointer.

Seeded on the agent-facing read commands the bead names:
`act status`, `status`, `next`, `debt status`, `debt next`,
`agents status`, `fleet`, `rig status`. Other commands get blocks as
their surfaces stabilize — absence of `contract` is legal and means
"undocumented", never "no flags".

### `bro contract dump [--json]`

A hidden registry plugin `contract` (dispatchable, off `--help` — a
consumer surface, not an operator one). `dump` prints a compact
name/group/skill table; `--json` emits the registry as data:

```json
{
  "version": 1,
  "groups": { "review": { "summary": "…", "members": ["act", …] } },
  "commands": {
    "act": {
      "name": "act", "group": "review", "summary": "…",
      "spellings": ["act", "review act"],
      "aliases": [], "deprecated": "…", "flatDeprecated": "…",
      "hidden": false, "skill": "act", "configKey": "act",
      "plan": true, "planVersion": 1,
      "contract": { "subs": { "status": { "flags": {…}, "exits": {…} } } },
      "external": false
    }
  }
}
```

Row fields are a superset of `bro plugins --json`
(`scripts/gen-command-docs.ts` switches to this dump — one source, not
two). `spellings` = flat spelling + `bro <group> <member>` when grouped;
`aliases` = the reverse-`aliasOf` map (names that alias TO this command).
Deterministic: no timestamps, no tool version — the committed snapshot
must diff clean on any machine.

### `contract/cli.json` + `check-contract` — the freeze gate

`contract/cli.json` is the committed, generated snapshot
(`{version, groups, commands, removed}`). `contract/BREAKING.md` is the
announcement ledger — one bullet per breaking change:
`- <command-or-dotted-path> — reason`.

`scripts/check-contract.ts` (`npm run check:contract`, `--write` =
`npm run gen:contract` regenerates):

- **drift gate** — recompute what `cli.json` should be and byte-compare;
  additions and changed scalars fail with "run `npm run gen:contract`".
- **breaking gate** — a key path present in the committed file's
  `commands`/`groups` but absent from the dump (command, subcommand,
  flag, exit code; a rename IS a remove+add), or a changed
  `group`/`aliasOf` (the invocation spelling moved), is breaking: it
  passes only when `BREAKING.md` has a bullet naming the command or the
  dotted path (announcing a command covers everything under it).
- **tombstones** — announced removals move to a top-level `removed`
  map on regen (old value preserved), so `cli.json` itself carries the
  1.x→2.0 history; every `removed` key must still be listed in
  BREAKING.md (the ledger can't be quietly edited around).
- `deprecated:`/`flatDeprecated:` additions are NOT breaking — a soft
  removal is itself the announcement.
- Fixture-friendly: `--contract <file>` / `--dump <file>` /
  `--breaking <file>` overrides keep git and the network out of the
  check; the diff/reconcile engine is pure and unit-tested.

CI: `npm run check:contract` runs next to `check:command-docs`, after
the build (the dump is read from `packages/cli/dist/index.js`).

## Plan

- [ ] `CliContract`/`CliSubContract` + `BroPlugin.contract` in core
- [ ] `commands/contract.ts` — dump rows + `runContractCommand` + the
      pure diff/reconcile engine
- [ ] registry entry (`hidden`) + `contract` blocks on the read commands
- [ ] `scripts/check-contract.ts` + `contract/cli.json` +
      `contract/BREAKING.md` + npm scripts + CI step
- [ ] gen-command-docs reads `contract dump --json`
- [ ] `commands/contract.test.ts` — dump shape + the removal/rename/
      addition fixture matrix

## Verify

- `contract.test.ts`: every registry command appears in the dump with
  group/spellings/aliases/deprecated/skill; hidden flagged; alias
  entries carry `aliasOf`.
- `contract.test.ts` fixtures: unannounced removal fails, announced
  removal passes and tombstones, addition fails "stale", clean passes.
- `npm run check:contract` green on the committed `contract/cli.json`;
  `npm run gen:contract` is byte-idempotent.
- `npm run check:command-docs` still green reading the dump.
- Live: `bro contract dump --json | jq '.commands | length'` equals the
  registry size.
