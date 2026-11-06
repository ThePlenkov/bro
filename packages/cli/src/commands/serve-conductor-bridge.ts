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

/** The property names no input may carry — they decide an object's
 *  shape, not its content. */
const UNSHAPEABLE = ['__proto__', 'constructor', 'prototype'];

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
function capabilityOf(kind: unknown): string[] | undefined {
  if (typeof kind !== 'string') return undefined;
  if (!Object.hasOwn(CAPABILITY, kind)) return undefined;
  const wanted = CAPABILITY[kind];
  return Array.isArray(wanted) ? wanted : undefined;
}

/** The request's tool contract — what the client allowed. A request that
 *  withheld its tools (tool_choice: none) allows no call at all; a request
 *  that NAMED a tool allows that one and no other. */
export interface ToolContract {
  /** false when the request withheld the tool contract */
  allowed: boolean;
  /** the tool the request named — undefined when it named none */
  name?: string;
}

/** The contract of a request that said nothing about its tools. */
export const OPEN_CONTRACT: ToolContract = { allowed: true };

/** The ACP tool call → the client's tool call — undefined when the client
 *  offers no tool that can run it, or when the request's own contract
 *  allows no call. */
export function clientCall(
  u: AcpToolCall,
  tools: ClientTool[],
  contract: ToolContract = OPEN_CONTRACT
): ClientCall | undefined {
  if (!contract.allowed) return undefined;
  if (u.sessionUpdate !== 'tool_call') return undefined;
  const wanted = capabilityOf(u.kind);
  if (wanted === undefined) return undefined;
  const raw = recordOf(u.rawInput);
  if (raw === undefined) return undefined;
  for (const tool of matchingTools(wanted, tools, contract.name)) {
    const input = toolInput(tool, raw);
    if (input !== undefined) return { name: tool.name, input, toolCallId: u.toolCallId };
  }
  return undefined;
}

/** The client's tools that answer the capability — in the capability's own
 *  order, so "edit" prefers the client's Edit over its Write. */
function matchingTools(wanted: string[], tools: ClientTool[], named?: string): ClientTool[] {
  // a request that named its tool asked for THAT tool: another tool of the
  // same capability is a different contract
  const offered = named === undefined ? tools : tools.filter(t => t.name === named);
  const out: ClientTool[] = [];
  for (const candidate of wanted) {
    out.push(...offered.filter(t => t.name.toLowerCase() === candidate));
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
    // the property names come from the client's own schema, and a schema
    // that declares one of these must not decide what the object we send
    // inherits or becomes
    if (UNSHAPEABLE.includes(prop)) continue;
    if (value === undefined) continue;
    // null is a value: the schema decides whether it is allowed, and the
    // client validates its own input
    if (!typeFits(tool, prop, value)) continue;
    input[prop] = value;
  }
  // a call with no input at all can still run a tool that takes no
  // arguments; a call whose fields did not map is a call we cannot shape
  if (Object.keys(input).length === 0 && Object.keys(raw).length > 0) return undefined;
  const missing = tool.required.filter(p => !Object.hasOwn(input, p));
  return missing.length === 0 ? input : undefined;
}

/** The value's type against the schema's own — a call the client cannot run
 *  never reaches it, and a number where the schema says string is such a
 *  call. */
function typeFits(tool: ClientTool, prop: string, value: unknown): boolean {
  const declared = tool.types[prop];
  if (declared === undefined || declared.length === 0) return true;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (declared.includes(actual)) return true;
  // an integer is a number that counts
  if (actual === 'number' && declared.includes('integer')) return Number.isInteger(value);
  return false;
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
