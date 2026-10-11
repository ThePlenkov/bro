/**
 * @broject/jira — the Jira connectors. `tasks`/`tasksAsync` map Jira
 * issues onto the TaskStore contract over the `atlassian` CLI's REST
 * passthrough. Two deployment surfaces share one mapping layer
 * (`buildTasks` over a bound `JiraApi`):
 *
 *   jira     — Jira Cloud v3 (spec bro-huy5o.3): accountId users, ADF
 *              bodies, /search/jql
 *   jira-dc  — Jira Data Center/Server v2 (spec bro-b8eom): name-keyed
 *              users, plain-string bodies, /search paged on startAt
 *
 * Scope: `JIRA_PROJECT`/`ATLASSIAN_PROJECT` names the serving project —
 * unset, the site's single visible project serves; zero/ambiguous
 * projects throw with the list. `JIRA_BASE_URL`/`ATLASSIAN_BASE_URL`
 * pins the site base (https only — the CLI sends its Authorization
 * header there); `JIRA_DC_BASE_URL` wins for the dc surface so a rig
 * can carry both connectors at once. Credentials stay the CLI's
 * (`atlassian auth login`, `ATLASSIAN_TOKEN` — a DC personal access
 * token rides that channel as Bearer when the CLI isn't in token
 * auth mode). The dc surface has no api.atlassian.com default — a
 * site base is required, resolved env-first then the CLI's own
 * config.
 *
 * Every facade is name-only (`optIn`): nothing about a repo's remote
 * or layout names a Jira project — pin `connectors.tasks` to 'jira'
 * or 'jira-dc'.
 */
import type { Connector } from '@broject/core'
import { cloudApi, dcApi } from './api.ts'
import {
  jiraDcTasks,
  jiraDcTasksAsync,
  jiraTasks,
  jiraTasksAsync,
} from './tasks.ts'

export { jiraTasks, jiraTasksAsync, jiraDcTasks, jiraDcTasksAsync }
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
      cloudApi().viewer(5_000)
      return null
    } catch (err) {
      return `jira: atlassian CLI not ready — ${err instanceof Error ? err.message : String(err)} (run 'atlassian auth login' or set ATLASSIAN_TOKEN)`
    }
  },
  tasks: (ctx) => jiraTasks(ctx.dir),
  tasksAsync: (ctx) => jiraTasksAsync(ctx.dir),
}

export const jiraDcConnector: Connector = {
  name: 'jira-dc',
  // same opt-in rule — a repo's remote can't name a DC site either
  optIn: true,
  /** The v2 /myself probe — also the site-base check: an unpinned DC
   *  endpoint errors inside viewer() before the spawn even happens. */
  auth() {
    try {
      dcApi().viewer(5_000)
      return null
    } catch (err) {
      return `jira-dc: atlassian CLI not ready — ${err instanceof Error ? err.message : String(err)} (pin JIRA_DC_BASE_URL to the DC site — JIRA_BASE_URL is shared and would redirect the cloud surface; ATLASSIAN_TOKEN carries the PAT as Bearer)`
    }
  },
  tasks: (ctx) => jiraDcTasks(ctx.dir),
  tasksAsync: (ctx) => jiraDcTasksAsync(ctx.dir),
}
