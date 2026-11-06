/**
 * The client's tools — the vocabulary the bridge speaks.
 *
 * The request that reaches the conductor carries the client's own tool
 * definitions: a name, a description, a JSON schema. The bridge needs two
 * things from each: the NAME the client executes under, and the shape of
 * the input it accepts (its required properties and its property names).
 *
 * The client's spelling is its own — "Bash", "Read", "Edit" — and the
 * bridge never guesses it: a tool the request did not offer is a tool the
 * client cannot run.
 */

/** The client's tool — the name it executes under and the shape its
 *  input takes. */
export interface ClientTool {
  /** the tool's name, as the client spells it */
  name: string;
  /** the schema's required properties */
  required: string[];
  /** the schema's property names */
  properties: string[];
  /** the schema's property types — the JSON types the client accepts.
   *  A property the schema says nothing about accepts anything. */
  types: Record<string, string[]>;
  /** the client's own input schema — the contract the call is validated
   *  against before it reaches the client. */
  schema?: unknown;
}

/** The request's tool definitions, as the client spelled them. */
export interface RawClientTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

/** The request's tool definitions → the bridge's vocabulary. */
export function clientTools(raw: RawClientTool[] | undefined): ClientTool[] {
  const out: ClientTool[] = [];
  for (const t of raw ?? []) {
    if (typeof t.name !== 'string' || t.name === '') continue;
    const shape = schemaOf(t.input_schema);
    out.push({
      name: t.name,
      required: shape.required,
      properties: shape.properties,
      types: shape.types,
      schema: t.input_schema,
    });
  }
  return out;
}

/**
 * The schema's required properties, its property names, and the type each
 * property declares. A schema's `properties` is an OBJECT — an array or a
 * string there is not a property map, and its keys are not property names.
 */
function schemaOf(schema: unknown): {
  required: string[];
  properties: string[];
  types: Record<string, string[]>;
} {
  const types: Record<string, string[]> = Object.create(null);
  const empty = { required: [], properties: [], types };
  if (typeof schema !== 'object' || schema === null) return empty;
  const s = schema as { required?: unknown; properties?: unknown };
  const props =
    typeof s.properties === 'object' && s.properties !== null && !Array.isArray(s.properties)
      ? (s.properties as Record<string, unknown>)
      : {};
  return {
    required: requiredOf(s.required),
    properties: Object.keys(props),
    types: typesOf(props),
  };
}

/** The schema's required properties — the strings among them. */
function requiredOf(declared: unknown): string[] {
  if (!Array.isArray(declared)) return [];
  return declared.filter((v): v is string => typeof v === 'string');
}

/** The type each property declares — one name, a list of names, or none.
 *  The table has NO prototype: a property the client names `__proto__` is an
 *  ordinary own entry, not a swap of the table's prototype. */
function typesOf(props: Record<string, unknown>): Record<string, string[]> {
  const types: Record<string, string[]> = Object.create(null);
  for (const [name, shape] of Object.entries(props)) {
    types[name] = declaredType((shape as { type?: unknown } | undefined)?.type);
  }
  return types;
}

/** A declared type as a list — a name, a list of names, or none. */
function declaredType(declared: unknown): string[] {
  if (Array.isArray(declared)) {
    return declared.filter((t): t is string => typeof t === 'string');
  }
  return typeof declared === 'string' ? [declared] : [];
}
