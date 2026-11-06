/**
 * The vocabulary the bridge matches by — the agent's kinds and the client's
 * spellings.
 *
 * The agent names a CAPABILITY ("execute", "edit"); the client spells its
 * tools its own way ("Bash", "Edit"). The tables below are the two
 * vocabularies, and the lookups are how a name in one finds its match in
 * the other. Nothing here touches the wire — it only says which tools
 * answer which capability.
 */
import type { ClientTool } from './serve-conductor-tools.ts';

/** The ACP kinds → the client tools that do the same thing, in order.
 *  The first candidate whose required properties the call covers wins. */
const CAPABILITY: Record<string, string[]> = {
  execute: ['bash', 'shell', 'terminal', 'run_command'],
  read: ['read', 'view', 'cat'],
  edit: ['edit', 'write', 'apply_patch'],
  search: ['grep', 'glob', 'search'],
  fetch: ['webfetch', 'fetch', 'websearch'],
};

/** The raw input's field names → the client's — the agent's shape differs
 *  from the client's, the schema is the contract. */
const ALIAS: Record<string, string> = {
  path: 'file_path',
  filepath: 'file_path',
  file: 'file_path',
  cmd: 'command',
  oldstring: 'old_string',
  newstring: 'new_string',
  old_text: 'old_string',
  new_text: 'new_string',
};

/** The capability the agent named — undefined when it names one this client
 *  does not have. The lookup is OWN-property only: the kind is the agent's
 *  string, and a plain object's prototype carries names of its own
 *  ("toString", "constructor") that are not capabilities. */
export function capabilityOf(kind: unknown): string[] | undefined {
  if (typeof kind !== 'string') return undefined;
  if (!Object.hasOwn(CAPABILITY, kind)) return undefined;
  const wanted = CAPABILITY[kind];
  return Array.isArray(wanted) ? wanted : undefined;
}

/** The client's tools that answer the capability — in the capability's own
 *  order, so "edit" prefers the client's Edit over its Write. */
export function matchingTools(
  wanted: string[],
  tools: ClientTool[],
  named?: string
): ClientTool[] {
  // a request that named its tool asked for THAT tool: another tool of the
  // same capability is a different contract
  const offered = named === undefined ? tools : tools.filter(t => t.name === named);
  const out: ClientTool[] = [];
  for (const candidate of wanted) {
    out.push(...offered.filter(t => t.name.toLowerCase() === candidate));
  }
  return out;
}

/** The raw input's field → the client's property — the schema's own name
 *  wins, the alias table covers the shapes that differ. */
export function propertyFor(tool: ClientTool, key: string): string | undefined {
  const hit = tool.properties.find(p => p.toLowerCase() === key.toLowerCase());
  if (hit !== undefined) return hit;
  const alias = ALIAS[key.toLowerCase()];
  if (alias === undefined) return undefined;
  return tool.properties.includes(alias) ? alias : undefined;
}
