/**
 * @bro/github — the GitHub connector. Provides the `reviews` facade
 * (PR state, threads, checks, merge) over the `gh` CLI. Registers like
 * any connector — built-in today, nothing GitHub-specific in core.
 */
import type { Connector } from '@bro/core'
import { githubReview } from './reviews.ts'

export { githubReview }

export const githubConnector: Connector = {
  name: 'github',
  /** github.com and GHES-style hosts; arbitrary enterprise domains fall
   *  back to `connectors.reviews` config when the URL doesn't match. */
  matchRemote(url: string): boolean {
    const host = url.match(/^(?:https?:\/\/|git@)([^/:]+)/i)?.[1]?.toLowerCase() ?? ''
    return host === 'github.com' || host.includes('github')
  },
  reviews: (ctx) => githubReview(ctx.dir),
}
