/**
 * `bro contract` — the machine-readable CLI surface (spec bro-k9ces).
 * Hidden plumbing: agents and transports (serve, mcp, ACP) read the
 * dump instead of parsing usage prose.
 *
 *   bro contract dump [--json]   registry → compact table / JSON doc
 *   bro contract check           committed contract/cli.json vs the live
 *                                dump — drift fails, an announced
 *                                removal (contract/BREAKING.md) does not
 *   bro contract gen             regenerate contract/cli.json
 *
 * check/gen take --contract/--dump/--breaking file overrides — the
 * reconcile engine is pure, so fixtures keep git and the network out.
 * They also build the live dump from core plugins only — external
 * plugins come from machine-local config and must not leak into the
 * committed snapshot.
 *
 * Canonical key paths (what BREAKING.md bullets and `removed`
 * tombstones name): a command is `<name>`, a group `groups.<g>`,
 * inside a command `<name>.contract|.group|.aliasOf|.argvPrefix|.json`
 * and `<name>[.subs.<s>].flags.<f>|.exits.<e>`. Announcing a path
 * covers everything under it.
 */
export { CONTRACT_VERSION } from './contract-shared.ts';
export type { ContractCommandRow, ContractDump } from './contract-dump.ts';
export { buildDump } from './contract-dump.ts';
export type { ContractDoc, ContractProblem } from './contract-shared.ts';
export { parseBreaking, reconcileContract } from './contract-reconcile.ts';
export { runContractCommand } from './contract-cli.ts';
