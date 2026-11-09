/**
 * The client's own schema — the last word on what the client runs.
 *
 * The bridge shapes a call in the client's vocabulary, but the CLIENT
 * decides whether it can run it: a number where the schema says string
 * is not a call the client can run, and a value below the tool's own
 * minimum is not either. These are the schema's verdicts, and the wire
 * sends no call they refuse.
 */
import { validateSchemaValue, type JsonSchema } from '@broject/core';
import type { ClientTool } from './serve-conductor-tools.ts';

/** The type a value has — by the names the client's schema declares. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** An integer is a number that counts. */
function integerValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

/** The 'integer' name asks for the whole numbers — but only when the
 *  client did not also accept any number. */
function integerFits(declared: string[], actual: string, value: unknown): boolean {
  return declared.includes('integer') && actual === 'number' && integerValue(value);
}

/** Whether the value fits the type the client declares for the property —
 *  a property the schema says nothing about accepts anything. */
export function typeFits(tool: ClientTool, prop: string, value: unknown): boolean {
  const types = tool.types;
  // the property is the CLIENT's own — one of the names its schema
  // declares. A name the client never declared accepts anything.
  if (!Object.hasOwn(types, prop)) return true;
  const declared = types[prop];
  if (declared.length === 0) return true;
  const actual = typeName(value);
  if (declared.includes(actual)) return true;
  return integerFits(declared, actual, value);
}

/** The client's own schema has the last word — the wire sends no call the
 *  client cannot run, and the client's schema is what decides that. A
 *  number below the tool's minimum is such a call. */
export function schemaAccepts(tool: ClientTool, input: Record<string, unknown>): boolean {
  const schema = tool.schema;
  if (typeof schema !== 'object' || schema === null) return true;
  return validateSchemaValue(input, schema as JsonSchema, 'input').length === 0;
}
