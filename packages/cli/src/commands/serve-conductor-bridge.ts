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
import { validateSchemaValue, type JsonSchema } from '@broject/core';
import { capabilityOf, matchingTools, propertyFor } from './serve-conductor-capabilities.ts';
import type { ClientTool } from './serve-conductor-tools.ts';

/** The ACP tool call, as the update carries it. */
export interface AcpToolCall {
  sessionUpdate: string;
  kind?: string | null;
  rawInput?: unknown;
  toolCallId?: string;
  /** the call's own status — a call that arrives already terminal has
   *  run, and a report is not a request */
  status?: string | null;
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

/** Whether the call already ran — the update says so, and a report is
 *  not a request. The agent did it in its own sandbox; a `tool_use`
 *  would make the client execute the same call a second time, on the
 *  client's own machine. */
function alreadyRan(u: AcpToolCall): boolean {
  return u.status === 'completed' || u.status === 'failed';
}

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
  if (alreadyRan(u)) return undefined;
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

/** The client's property this raw field maps to — undefined when the field
 *  has no property, the property cannot be shaped, the value is absent, or
 *  the value's type contradicts the schema. */
function mappedProperty(
  tool: ClientTool,
  key: string,
  value: unknown
): string | undefined {
  const prop = propertyFor(tool, key);
  if (prop === undefined) return undefined;
  // the property names come from the client's own schema, and a schema
  // that declares one of these must not decide what the object we send
  // inherits or becomes
  if (UNSHAPEABLE.includes(prop)) return undefined;
  if (value === undefined) return undefined;
  // null is a value: the schema decides whether it is allowed, and the
  // client validates its own input
  if (!typeFits(tool, prop, value)) return undefined;
  return prop;
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
    const prop = mappedProperty(tool, key, value);
    if (prop !== undefined) input[prop] = value;
  }
  // a call with no input at all can still run a tool that takes no
  // arguments; a call whose fields did not map is a call we cannot shape
  if (Object.keys(input).length === 0 && Object.keys(raw).length > 0) return undefined;
  const missing = tool.required.filter(p => !Object.hasOwn(input, p));
  if (missing.length > 0) return undefined;
  return schemaAccepts(tool, input) ? input : undefined;
}

/** The client's own schema has the last word — the wire sends no call the
 *  client cannot run, and the client's schema is what decides that. A
 *  number below the tool's minimum is such a call. */
function schemaAccepts(tool: ClientTool, input: Record<string, unknown>): boolean {
  const schema = tool.schema;
  if (typeof schema !== 'object' || schema === null) return true;
  return validateSchemaValue(input, schema as JsonSchema, 'input').length === 0;
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

/** The raw input as a record — undefined when it is not an object. */
function recordOf(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}
