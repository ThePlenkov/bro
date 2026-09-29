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
  /** Label-boundary host match — github.com and GHES-style
   *  `github.corp.com`, but not lookalikes (evilgithub.com). Arbitrary
   *  enterprise hosts resolve via `connectors.reviews` config. */
  matchRemote(url: string): boolean {
    const host = url.match(/^(?:https?:\/\/|git@)([^/:]+)/i)?.[1]?.toLowerCase() ?? ''
    return host.split('.').includes('github')
  },
  reviews: (ctx) => githubReview(ctx.dir),
}
