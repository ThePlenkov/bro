/**
 * The bridge — an agent's tool call, in the client's vocabulary.
 *
 * The conductor speaks two protocols: Anthropic to the client, ACP to the
 * agent. The agent's tool call arrives in ACP's shape (a `kind`, a raw
 * input); the client executes in its own (a name, a JSON input the
 * request's schema validates). The bridge translates the first into the
 * second — BY CAPABILITY, never by name: the agent calls "execute", the
 * client offers "Bash".
 *
 * A call that cannot be translated stays what it was: a narrated edge.
 * The wire never invents a call the client cannot execute, and it never
 * drops one it can.
 */
import type { ClientTool } from './serve-conductor-tools.ts';

/** The ACP tool call, as the update carries it. */
export interface AcpToolCall {
  sessionUpdate: string;
  kind?: string | null;
  rawInput?: unknown;
  toolCallId?: string;
}

/** The client's tool call — the name and the input the client executes. */
export interface ClientCall {
  /** the client's tool name */
  name: string;
  /** the input, in the client's schema */
  input: Record<string, unknown>;
  /** the ACP call's id — the call's narration is the client's now */
  toolCallId?: string;
}

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

/** The ACP tool call → the client's tool call — undefined when the client
 *  offers no tool that can run it. */
export function clientCall(u: AcpToolCall, tools: ClientTool[]): ClientCall | undefined {
  if (u.sessionUpdate !== 'tool_call') return undefined;
  const wanted = typeof u.kind === 'string' ? CAPABILITY[u.kind] : undefined;
  if (wanted === undefined) return undefined;
  const raw = recordOf(u.rawInput);
  if (raw === undefined) return undefined;
  for (const tool of matchingTools(wanted, tools)) {
    const input = toolInput(tool, raw);
    if (input !== undefined) return { name: tool.name, input, toolCallId: u.toolCallId };
  }
  return undefined;
}

/** The client's tools that answer the capability — in the capability's own
 *  order, so "edit" prefers the client's Edit over its Write. */
function matchingTools(wanted: string[], tools: ClientTool[]): ClientTool[] {
  const out: ClientTool[] = [];
  for (const candidate of wanted) {
    out.push(...tools.filter(t => t.name.toLowerCase() === candidate));
  }
  return out;
}

/** The call's input in the client's schema — undefined when the schema's
 *  required properties are not all covered (the wire never invents an
 *  argument, and never sends a call the client cannot run). */
function toolInput(
  tool: ClientTool,
  raw: Record<string, unknown>
): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const prop = propertyFor(tool, key);
    if (prop === undefined) continue;
    if (value === undefined || value === null) continue;
    input[prop] = value;
  }
  if (Object.keys(input).length === 0) return undefined;
  const missing = tool.required.filter(p => input[p] === undefined);
  return missing.length === 0 ? input : undefined;
}

/** The raw input's field → the client's property — the schema's own name
 *  wins, the alias table covers the shapes that differ. */
function propertyFor(tool: ClientTool, key: string): string | undefined {
  const hit = tool.properties.find(p => p.toLowerCase() === key.toLowerCase());
  if (hit !== undefined) return hit;
  const alias = ALIAS[key.toLowerCase()];
  if (alias === undefined) return undefined;
  return tool.properties.includes(alias) ? alias : undefined;
}

/** The raw input as a record — undefined when it is not an object. */
function recordOf(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}
