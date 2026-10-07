/**
 * The github connector's `queries` facade — `gh api graphql` with the
 * document and scalar vars as `-f` fields (spec bro-14h8.1, milestone
 * 3). `-f` values are strings on the wire; tables/arrays are rejected
 * here (run time) because a step's provider isn't known at validate
 * time — the atlassian connector takes the same vars verbatim instead.
 */
import { ghAsync } from '@broject/core'
import type { QueryFacade, QueryResult } from '@broject/core'

function fieldVars(vars: Record<string, unknown> | undefined): string[] {
  const args: string[] = []
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new TypeError(
        `github queries: var "${k}" is non-scalar — gh -f fields take string/number/bool only`
      )
    }
    args.push('-f', `${k}=${v}`)
  }
  return args
}

export function githubQueries(dir: string): QueryFacade {
  return {
    async graphql(doc, opts): Promise<QueryResult> {
      const args = ['api', 'graphql', '-f', `query=${doc}`, ...fieldVars(opts?.vars)]
      const out = await ghAsync(args, dir, { env: opts?.env })
      const parsed = JSON.parse(out) as { data?: unknown; errors?: unknown }
      const res: QueryResult = {}
      if (parsed.data !== undefined) {
        res.data = parsed.data
      }
      if (parsed.errors !== undefined) {
        res.errors = parsed.errors
      }
      return res
    },
  }
}
