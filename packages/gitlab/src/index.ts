/**
 * @broject/gitlab — the GitLab connector. Provides the `reviews` facade
 * (MR state, threads, checks, merge) over the `glab` CLI. Registers like
 * any connector — built-in today, nothing GitLab-specific in core.
 */
import type { Connector } from '@broject/core'
import { glabTry } from './glab.ts'
import { gitlabReview, hostFor } from './reviews.ts'

export { gitlabReview }

export const gitlabConnector: Connector = {
  name: 'gitlab',
  /** gitlab.com hosts only — the bare domain or a subdomain. A `gitlab`
   *  label anywhere else can't be told from a lookalike syntactically
   *  (`gitlab.corp.com` vs `gitlab.com.evil.com`), so self-hosted
   *  instances resolve via `connectors.reviews` config. */
  matchRemote(url: string): boolean {
    const host =
      /^(?:https?:\/\/|ssh:\/\/[^@]+@|[^@\s]+@)([^/:]+)/i.exec(url)?.[1]?.toLowerCase() ?? ''
    return host === 'gitlab.com' || host.endsWith('.gitlab.com')
  },
  /** `glab auth status` — covers both "glab missing" (spawn failure →
   *  nonzero code) and "glab present but logged out". */
  auth(ctx) {
    const host = hostFor(ctx.dir)
    const args = ['auth', 'status']
    if (host !== 'gitlab.com') {
      args.push('--hostname', host)
    }
    return glabTry(args, ctx.dir).code === 0
      ? null
      : `glab not authenticated for ${host} — run \`glab auth login\``
  },
  reviews: (ctx) => gitlabReview(ctx.dir),
}
