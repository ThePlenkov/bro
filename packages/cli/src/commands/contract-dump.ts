import type { BroPlugin, CliContract, CliSubContract } from '@broject/core';
import { CONTRACT_VERSION } from './contract-shared.ts';

export interface ContractCommandRow {
  name: string;
  group?: string;
  summary: string;
  /** Every invocation spelling — the flat `bro <name>` plus
   *  `bro <group> <name>` for grouped members. A group host has no
   *  second spelling (`bro plan plan` is not one). */
  spellings: string[];
  /** Names that alias TO this command (reverse aliasOf). */
  aliases: string[];
  aliasOf?: string;
  deprecated?: string;
  flatDeprecated?: string;
  hidden: boolean;
  skill?: string;
  configKey?: string;
  plan: boolean;
  planVersion?: number;
  /** Argv spliced ahead of the user's args — a reroute as real as
   *  aliasOf (`unwind` → `drill up`). */
  argvPrefix?: string[];
  contract?: CliContract;
  external: boolean;
}

export interface ContractDump {
  version: number;
  groups: Record<string, { summary?: string; members: string[] }>;
  commands: Record<string, ContractCommandRow>;
}

function spellings(p: BroPlugin): string[] {
  return p.group !== undefined && p.group !== p.name ? [p.name, `${p.group} ${p.name}`] : [p.name];
}

function commandRow(p: BroPlugin, aliases: string[]): ContractCommandRow {
  return {
    name: p.name,
    group: p.group,
    summary: p.summary,
    spellings: spellings(p),
    aliases,
    aliasOf: p.aliasOf,
    deprecated: p.deprecated,
    flatDeprecated: p.flatDeprecated,
    hidden: p.hidden === true,
    skill: p.skill,
    configKey: p.configKey,
    plan: p.planSchema !== undefined,
    planVersion: p.planSchema !== undefined ? (p.planVersion ?? 1) : undefined,
    argvPrefix: p.argvPrefix,
    contract: p.contract,
    external: p.external === true,
  };
}

/** Groups in declared-meta order first, then groups only external
 *  plugins add; every plugin lands in its group's members. */
function groupRows(
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): Map<string, { summary?: string; members: string[] }> {
  const meta = new Map(groupMeta);
  const order = [
    ...meta.keys(),
    ...plugins.map(p => p.group).filter((g): g is string => g !== undefined && !meta.has(g)),
  ];
  const rows = new Map<string, { summary?: string; members: string[] }>();
  for (const g of order) {
    rows.set(g, { summary: meta.get(g), members: [] });
  }
  for (const p of plugins) {
    if (p.group !== undefined) {
      rows.get(p.group)?.members.push(p.name);
    }
  }
  return rows;
}

/** The live registry as the contract document — deterministic: key
 *  order is registry/group order, no timestamps, no tool version.
 *  Maps → Object.fromEntries, so a plugin named `__proto__` still
 *  lands as an own enumerable key. */
export function buildDump(
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): ContractDump {
  // name → the commands that alias to it (registry order)
  const aliasTo = new Map<string, string[]>();
  for (const p of plugins) {
    if (p.aliasOf !== undefined) {
      const target = p.aliasOf.split(' ')[0] ?? '';
      aliasTo.set(target, [...(aliasTo.get(target) ?? []), p.name]);
    }
  }
  const commands = new Map<string, ContractCommandRow>();
  for (const p of plugins) {
    commands.set(p.name, commandRow(p, aliasTo.get(p.name) ?? []));
  }
  return {
    version: CONTRACT_VERSION,
    groups: Object.fromEntries(groupRows(plugins, groupMeta)),
    commands: Object.fromEntries(commands),
  };
}

export { CONTRACT_VERSION };
