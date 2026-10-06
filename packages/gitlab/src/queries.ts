/**
 * The gitlab connector's `queries` facade — `glab api graphql` with
 * the document and scalar vars as `-f` fields (spec bro-14h8.1,
 * milestone 4). GITLAB_HOST pins to the detected remote's instance
 * unless the step's env overlay already names one — the pin exists so
 * a self-hosted repo's steps don't silently hit gitlab.com.
 */
import type { QueryFacade, QueryResult } from '@broject/core'
import { glabAsync } from './glab.ts'
import { hostFor } from './reviews.ts'

function fieldVars(vars: Record<string, unknown> | undefined): string[] {
  const args: string[] = []
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(
        `gitlab queries: var "${k}" is non-scalar — glab -f fields take string/number/bool only`
      )
    }
    args.push('-f', `${k}=${v}`)
  }
  return args
}

export function gitlabQueries(dir: string): QueryFacade {
  return {
    async graphql(doc, opts): Promise<QueryResult> {
      const args = ['api', 'graphql', '-f', `query=${doc}`, ...fieldVars(opts?.vars)]
      const env = { GITLAB_HOST: hostFor(dir), ...opts?.env }
      const out = await glabAsync(args, { cwd: dir, env })
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
