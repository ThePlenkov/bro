/**
 * The `queries` facade — a connector's raw GraphQL data plane
 * (spec bro-14h8.1). Named by domain semantics like `reviews`/`tasks`;
 * GraphQL is an open spec, not a vendor API, so the name is honest.
 *
 * Data plane ≠ model plane: `providers[]` configures model calls,
 * `query` plans run GraphQL against connectors that point at real
 * endpoints (github, gitlab, atlassian, …).
 */
export interface QueryResult {
  /** The response's `data` field, when present. */
  data?: unknown
  /** GraphQL response errors — `data` may still hold partial data. */
  errors?: unknown
}

export interface QueryOpts {
  /** Document variables — GraphQL vars are arbitrary JSON; CLI-field
   *  providers (gh `-f`, glab) accept scalars only and reject
   *  tables/arrays at run time. */
  vars?: Record<string, unknown>
  /** Literal env overlay for the spawned provider CLI — variable
   *  names → values, never a list of names to inherit. */
  env?: Record<string, string>
}

export interface QueryFacade {
  graphql(doc: string, opts?: QueryOpts): Promise<QueryResult>
}
