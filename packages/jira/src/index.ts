/**
 * @broject/jira — the Jira connector. `tasks`/`tasksAsync` map Jira
 * issues onto the TaskStore contract over the `atlassian` CLI's REST
 * passthrough (spec bro-huy5o.3).
 *
 * Scope: `JIRA_PROJECT`/`ATLASSIAN_PROJECT` names the serving project —
 * unset, the site's single visible project serves; zero/ambiguous
 * projects throw with the list. `JIRA_BASE_URL` pins a site (self-
 * hosted / Data Center too); unset, the CLI's own config answers.
 * Credentials stay the CLI's (`atlassian auth login`, ATLASSIAN_TOKEN).
 *
 * Every facade is name-only (`optIn`): nothing about a repo's remote
 * or layout names a Jira project — pin `connectors.tasks` to 'jira'.
 */
import type { Connector } from '@broject/core'
import { viewer } from './api.ts'
import { jiraTasks, jiraTasksAsync } from './tasks.ts'

export { jiraTasks, jiraTasksAsync }
export { adfDoc, adfText } from './tasks.ts'

export const jiraConnector: Connector = {
  name: 'jira',
  // opt-in only: nothing about a repo's remote or layout implies Jira —
  // a step names it, or connectors.tasks pins it
  optIn: true,
  /** A live /myself probe with a tight budget — a missing/unauthed CLI
   *  reports the remediation line instead of crashing doctor; the
   *  viewer() cache makes repeat calls free. Never throws. */
  auth() {
    try {
      viewer(5_000)
      return null
    } catch (err) {
      return `jira: atlassian CLI not ready — ${err instanceof Error ? err.message : String(err)} (run 'atlassian auth login' or set ATLASSIAN_TOKEN)`
    }
  },
  tasks: (ctx) => jiraTasks(ctx.dir),
  tasksAsync: (ctx) => jiraTasksAsync(ctx.dir),
}
