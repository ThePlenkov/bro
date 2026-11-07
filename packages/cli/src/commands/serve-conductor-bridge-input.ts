/**
 * The raw input — the agent's own shape — into the client's.
 *
 * The agent names its fields the way it wants ("path", "cmd"); the client
 * names its properties the way it wants ("file_path", "command"). The
 * client's schema is the contract: the fields that map onto the client's
 * own properties are sent, the rest are dropped, and a call whose required
 * properties are not all covered is a call the client cannot run.
 */
import { propertyFor } from './serve-conductor-capabilities.ts';
import { schemaAccepts, typeFits } from './serve-conductor-bridge-schema.ts';
import type { ClientTool } from './serve-conductor-tools.ts';

/** The property names no input may carry — they decide an object's
 *  shape, not its content. */
const UNSHAPEABLE = ['__proto__', 'constructor', 'prototype'];

/** The raw input as a record — undefined when it is not an object. */
export function recordOf(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** The client's property this raw field maps to — undefined when the field
 *  has no property, or the property cannot be shaped. */
function shapedProp(tool: ClientTool, key: string): string | undefined {
  const prop = propertyFor(tool, key);
  if (prop === undefined) return undefined;
  // the property names come from the client's own schema, and a schema
  // that declares one of these must not decide what the object we send
  // inherits or becomes
  if (UNSHAPEABLE.includes(prop)) return undefined;
  return prop;
}

/** The client's property this raw field maps to — undefined when the field
 *  has no property, the property cannot be shaped, the value is absent, or
 *  the value's type contradicts the schema. */
function mappedProperty(tool: ClientTool, key: string, value: unknown): string | undefined {
  const prop = shapedProp(tool, key);
  if (prop === undefined) return undefined;
  if (value === undefined) return undefined;
  // null is a value: the schema decides whether it is allowed, and the
  // client validates its own input
  if (!typeFits(tool, prop, value)) return undefined;
  return prop;
}

/** The client's input for the raw fields — the mapped properties only. */
function mappedInput(tool: ClientTool, raw: Record<string, unknown>): Record<string, unknown> {
  const pairs: [string, unknown][] = [];
  for (const [key, value] of Object.entries(raw)) {
    const prop = mappedProperty(tool, key, value);
    if (prop !== undefined) pairs.push([prop, value]);
  }
  // the pairs become the client's own object: fromEntries writes each
  // property as an OWN entry, so even a name that is a setter on
  // Object.prototype lands as data and not as a prototype swap
  return Object.fromEntries(pairs);
}

/** The call's input in the client's schema — undefined when the schema's
 *  required properties are not all covered (the wire never invents an
 *  argument, and never sends a call the client cannot run). */
export function toolInput(
  tool: ClientTool,
  raw: Record<string, unknown>
): Record<string, unknown> | undefined {
  const input = mappedInput(tool, raw);
  // a call with no input at all can still run a tool that takes no
  // arguments; a call whose fields did not map is a call we cannot shape
  if (Object.keys(input).length === 0 && Object.keys(raw).length > 0) return undefined;
  const missing = tool.required.filter(p => !Object.hasOwn(input, p));
  if (missing.length > 0) return undefined;
  return schemaAccepts(tool, input) ? input : undefined;
}
