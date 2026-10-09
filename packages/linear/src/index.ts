/**
 * @broject/linear — the Linear connector. `tasks`/`tasksAsync` map
 * Linear issues onto the TaskStore contract (spec bro-huy5o.2);
 * `queries` fans bro query plans out to Linear's GraphQL API.
 *
 * Scope: `LINEAR_TEAM` (key or UUID) names the serving team — unset,
 * the workspace's single team serves; zero/ambiguous teams throw with
 * the list. `LINEAR_API_KEY` is the only credential (personal key,
 * verbatim Authorization header).
 *
 * Every facade is name-only (`optIn`): nothing about a repo's remote or
 * layout names a Linear workspace — pin `connectors.tasks`/`queries`.
 */
import type { Connector } from '@broject/core'
import { apiKey, viewer } from './api.ts'
import { linearQueries } from './queries.ts'
import { linearTasks, linearTasksAsync } from './tasks.ts'

export { apiKey, linearQueries, linearTasks, linearTasksAsync }
export type { FetchFn, LinearResp, LinearTeam, LinearViewer, TeamMeta } from './api.ts'

export const linearConnector: Connector = {
  name: 'linear',
  optIn: true,
  /** Key presence first (cheap), then a live viewer probe with a tight
   *  budget — a revoked key reports the remediation line instead of
   *  crashing doctor; a passing probe is cached so the check is free on
   *  repeat calls. Never throws — doctor prints the line. */
  auth() {
    try {
      apiKey()
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    try {
      viewerProbe()
      return null
    } catch (err) {
      return `linear: LINEAR_API_KEY not usable — ${err instanceof Error ? err.message : String(err)}`
    }
  },
  tasks: (ctx) => linearTasks(ctx.dir),
  tasksAsync: (ctx) => linearTasksAsync(ctx.dir),
  queries: () => linearQueries(),
}

/** auth()'s live check — the shared viewer() cache keeps repeats free;
 *  a 5s curl ceiling keeps doctor from stalling on a dead network. */
function viewerProbe(): void {
  viewer(5_000)
}
