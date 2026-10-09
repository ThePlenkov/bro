/**
 * The linear connector's `queries` facade — raw GraphQL passthrough to
 * https://api.linear.app/graphql (spec bro-14h8.1). `data`/`errors`
 * ride back verbatim; only transport failures (HTTP !ok, non-JSON)
 * throw. `opts.vars` become the variables body; `opts.env` may carry a
 * LINEAR_API_KEY overlay (a plan pinning its own key) but nothing else
 * can redirect — the endpoint is a constant, so a step's env overlay
 * can never point the Authorization header at a foreign host.
 */
import type { QueryFacade, QueryResult } from '@broject/core'
import type { FetchFn } from './api.ts'
import { gqlRaw } from './api.ts'

export function linearQueries(opts?: { fetch?: FetchFn }): QueryFacade {
  return {
    graphql: async (doc, q): Promise<QueryResult> => {
      const r = await gqlRaw(doc, q?.vars, q?.env, opts?.fetch)
      const res: QueryResult = {}
      if (r.data !== undefined) {
        res.data = r.data
      }
      if (r.errors !== undefined) {
        res.errors = r.errors
      }
      return res
    },
  }
}
