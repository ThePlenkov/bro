/**
 * @broject/github — the GitHub connector. Provides the `reviews` facade
 * (PR state, threads, checks, merge) over the `gh` CLI. Registers like
 * any connector — built-in today, nothing GitHub-specific in core.
 */
import { ghTry, type Connector } from '@broject/core'
import { githubReview } from './reviews.ts'
import { githubQueries } from './queries.ts'

export { githubReview, githubQueries }

export const githubConnector: Connector = {
  name: 'github',
  /** github.com hosts only — the bare domain or a subdomain. A `github`
   *  label anywhere else can't be told from a lookalike syntactically
   *  (`github.corp.com` vs `github.com.evil.com`), so GHES-style hosts
   *  resolve via `connectors.reviews` config. */
  matchRemote(url: string): boolean {
    const host = url.match(/^(?:https?:\/\/|git@)([^/:]+)/i)?.[1]?.toLowerCase() ?? ''
    return host === 'github.com' || host.endsWith('.github.com')
  },
  /** `gh auth status` — covers both "gh missing" (spawn failure →
   *  nonzero code) and "gh present but logged out". */
  auth() {
    return ghTry(['auth', 'status']).code === 0
      ? null
      : 'gh not authenticated — run `gh auth login`'
  },
  reviews: (ctx) => githubReview(ctx.dir),
  queries: (ctx) => githubQueries(ctx.dir),
}
