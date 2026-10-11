# @broject/jira

The Jira connector for `bro` — the `tasks` facade (`TaskStore`/`TaskStoreAsync`)
over the `atlassian` CLI's REST passthrough (`atlassian api <METHOD> <endpoint>
--json`). One uniform verb reaches the whole Jira Cloud surface: JQL search,
issue links, transitions, assignee, comments.

Same mapping contract as `github-issues` (bro-huy5o.1) and `linear`
(bro-huy5o.2):

| contract | Jira |
| --- | --- |
| `id` | issue key (`PROJ-123`); bare numbers resolve inside the serving project, `/browse/` URLs pass through |
| `status` | statusCategory `done` → `closed`, `indeterminate` → `in_progress`; `new`/other → `in_progress` (assignee) \| `blocked` \| `open` |
| `blocked` | unresolved `Blocks` link landing inward, open sub-task, or the `blocked` label |
| `ready` | JQL `project = K AND statusCategory != Done AND assignee is EMPTY`, priority then created |
| `claim` | assignee write + verify re-read; a start transition rides best-effort |
| `close` | comment reason → first `done` transition |
| `reopen` | transition to `new` (fallback `indeterminate`) + unassign + drop the label |
| `type` | native `issuetype` wins, then `type:`/`kind:`/`epic` labels, then the bro trailer |
| `priority` | positional over the site's ordered `/priority` list onto bd's 0–4 |
| `deps` | `issuelinks` + `parent`/`subtasks` → canonical `TaskDepEdge` rows |
| `link` | `blocked`→Blocks (`to` outward), `related`→Relates, `parent`→`fields.parent`; site customs resolve by name |
| `children` | hydrated `subtasks` rows |

## Setup

- `atlassian` CLI on PATH, authenticated (`atlassian auth login` or
  `ATLASSIAN_TOKEN`) — the connector never reads credentials itself.
- `JIRA_PROJECT`/`ATLASSIAN_PROJECT` names the serving project. Unset, the
  site's single visible project serves; zero or several throw with the list.
- `JIRA_BASE_URL`/`ATLASSIAN_BASE_URL` pins a site (https only — the CLI sends
  its Authorization header there). Unset, the CLI's own config decides; a
  `cloudId`-only config reaches the gateway via `/ex/jira/<cloudId>/rest/api/3/…`.

## Selection

Name-only (`optIn`) — nothing about a repo's remote or layout identifies a
Jira project:

```json
{ "connectors": { "tasks": "jira" } }
```

## Honest absences

- `publish` is not implemented — Jira has no bead→issue projection mapping
  in this milestone.
- Custom link types pass through lowercased on read; `link()` resolves them
  against the site's `issueLinkType` table and throws when nothing matches —
  never faked as a comment.
- `description` is ADF↔text mapped; the `<!-- bro: … -->` trailer rides a
  plain paragraph and survives verbatim.
