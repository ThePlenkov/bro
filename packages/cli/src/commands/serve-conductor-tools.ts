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
    out.push({ name: t.name, required: shape.required, properties: shape.properties });
  }
  return out;
}

/** The schema's required properties and its property names. */
function schemaOf(schema: unknown): { required: string[]; properties: string[] } {
  if (typeof schema !== 'object' || schema === null) return { required: [], properties: [] };
  const s = schema as { required?: unknown; properties?: unknown };
  const required = Array.isArray(s.required)
    ? s.required.filter((v): v is string => typeof v === 'string')
    : [];
  const properties =
    typeof s.properties === 'object' && s.properties !== null ? Object.keys(s.properties) : [];
  return { required, properties };
}
