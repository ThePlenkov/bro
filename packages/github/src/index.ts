/**
 * @broject/github — the GitHub connector. Provides the `reviews` facade
 * (PR state, threads, checks, merge) over the `gh` CLI. Registers like
 * any connector — built-in today, nothing GitHub-specific in core.
 */
import { ghTry, type Connector } from '@broject/core'
import { githubReview } from './reviews.ts'
import { githubQueries } from './queries.ts'
import { githubStacks } from './stacks.ts'
import { githubTasks, githubTasksAsync } from './tasks.ts'
import {
  graphiteConnector,
  graphiteQueue,
  mergifyConnector,
  mergifyQueue,
} from './merge-queue.ts'

export {
  githubReview,
  githubQueries,
  githubStacks,
  githubTasks,
  githubTasksAsync,
  graphiteConnector,
  mergifyConnector,
  mergifyQueue,
  graphiteQueue,
}
export {
  GITHUB_TOPIC_PREFIX,
  GITHUB_WEBHOOK_SECRET_ENV,
  githubEventConcernsPr,
  githubPrWake,
  githubWebhookEvent,
  githubWebhookHandler,
  parseGithubWebhookBody,
  verifyGithubWebhook,
} from './webhooks.ts'
export type {
  GithubWebhookDeps,
  GithubWebhookRequest,
  GithubWebhookResponse,
} from './webhooks.ts'

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
  /** `tasks` exists but is name-only — a github remote must not flip a
   *  beads repo's task store by detection. Pin it:
   *  `"connectors": {"tasks": "github"}` (+ `stores: ["jsonl"]` for the
   *  zero-install shape — spec specs/bro-huy5o.1.md). */
  optInFacades: ['tasks', 'tasksAsync'],
  reviews: (ctx) => githubReview(ctx.dir),
  queries: (ctx) => githubQueries(ctx.dir),
  stacks: (ctx) => githubStacks(ctx.dir),
  tasks: (ctx) => githubTasks(ctx.dir),
  tasksAsync: (ctx) => githubTasksAsync(ctx.dir),
}
