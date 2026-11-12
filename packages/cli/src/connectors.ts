/**
 * Built-in connector registration — the probe plane `bro hooks <event>`
 * dispatches through. Lives apart from plugins.ts so the slim hook
 * entry (dist/hooks.js — specs/sessions/bro-36sx7.md #9) registers the
 * same connectors without evaluating the ~81-plugin command registry.
 * plugins.ts imports this module for the side effect, so the main CLI
 * registers exactly what it did before; registration order is the
 * contract either way.
 */
import { busConnector, mailboxConnector, notifyConnector, registerConnector } from '@broject/core';
import { actConnector } from '@broject/act';
import { debtConnector } from '@broject/debt';
import { drillConnector } from '@broject/drill';
import { learnConnector } from '@broject/learn';
import { githubConnector, graphiteConnector, mergifyConnector } from '@broject/github';
import { gitlabConnector } from '@broject/gitlab';
import { linearConnector } from '@broject/linear';
import { jiraConnector, jiraDcConnector } from '@broject/jira';
import { atlassianConnector } from '@broject/query';
import { guardConnector } from '@broject/guard';
import { llmJudgeConnector, systemoneConnector } from '@broject/judge';
import { rigConnector } from './commands/rig-pulse.ts';
import { driveConnector } from './commands/drive-pulse.ts';
import { loopConnector } from './commands/loop-pulse.ts';
import { watchConnector } from './commands/watch-pulse.ts';
import { sddConnector } from './commands/spec.ts';
import { sessionCapConnector } from './commands/session-cap.ts';
import { herdrConnector } from './commands/herdr-connector.ts';
import { SPEC_CONNECTORS } from './spec-connectors.ts';
import { specConnector } from '@broject/spec';
import { workConnector } from './commands/work.ts';

// Built-in connectors register at module load, ahead of external
// plugins — registry order is the fallback precedence, and an external
// connector must not shadow a built-in system. Registration order also
// decides stop-gate block priority: drill > work > act.
registerConnector(githubConnector);
registerConnector(gitlabConnector);
// external merge queues — opt-in only (`connectors.mergeQueue`), they
// provide nothing but the queue facade so nothing detects them
registerConnector(mergifyConnector);
registerConnector(graphiteConnector);
// queries-facade provider — opt-in only (a step names it or
// connectors.queries pins it); nothing about a repo detects Atlassian
registerConnector(atlassianConnector);
// Linear — tasks + tasksAsync + queries, all name-only pins
// (connectors.tasks=linear); a repo's remote can't name a Linear team
registerConnector(linearConnector);
// Jira — tasks + tasksAsync over the atlassian CLI's REST surface,
// name-only pins (connectors.tasks=jira); a remote can't name a project
registerConnector(jiraConnector);
// Jira Data Center/Server — the same tasks facade on the v2 REST
// surface (name-keyed users, string bodies, /search), name-only
registerConnector(jiraDcConnector);
registerConnector(drillConnector);
registerConnector(workConnector);
registerConnector(actConnector);
// the pulse's rearm nudge — same family as act's dead-watch flags
registerConnector(watchConnector);
// the installed merge path's rearm checkpoint — drive.json's owner
registerConnector(driveConnector);
registerConnector(loopConnector);
registerConnector(rigConnector);
registerConnector(debtConnector);
registerConnector(sddConnector);
// the host-wide session cap — refuses a session start at the cap
registerConnector(sessionCapConnector);
registerConnector(notifyConnector);
// pane report-back — env-gated inside the connector; outside herdr
// every probe is a no-op (spec bro-84zrj)
registerConnector(herdrConnector);
registerConnector(learnConnector);
registerConnector(systemoneConnector);
registerConnector(llmJudgeConnector);
// the builtins' home — guard defs contributed here shadow by name
// behind config defs, so a project's `guard.defs` always wins a rename
registerConnector(guardConnector);
// events facade providers — registry order is the fallback precedence,
// so `mailbox` first: `bro notify` must keep working with no broker and
// no config. The bus is opt-in via `connectors.events` in bro.config.json.
registerConnector(mailboxConnector);
registerConnector(busConnector);
// specs facade providers — registry order is detection precedence:
// `brose` first (it claims trees carrying *.spec.md Brotocol docs and
// defers to tool layouts), then native (its matchDir claims the
// configured sdd.dir), tool-layout matchers, agent last (explicit pick
// only, never detects)
registerConnector(specConnector);
for (const c of SPEC_CONNECTORS) {
  registerConnector(c);
}
