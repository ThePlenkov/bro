---
scope:
  - packages/jira/
  - packages/cli/src/plugins.ts
---

# bro-b8eom — jira connector: Jira Data Center/Server (v2 REST surface)

Deferred from PR #435 thread PRRT_kwDOUamqtM6rJC3J — codeant flagged
`/rest/api/3` hardcoded while docs advertised Data Center. That PR
narrowed scope to Jira Cloud; this spec is the promised separate
surface.

## Problem

Self-hosted Jira (Data Center, and the Server line it replaces) speaks
the v2 REST API. The deltas from Cloud v3 are structural, not paths:
users are `name`/`key`-keyed (no `accountId`), description/comment
bodies are plain strings (no ADF), JQL is `POST /search` paged on
`startAt`/`total` (no `/search/jql`, no `nextPageToken`), and the
project listing is `GET /project` (an array — no `/project/search`).
Swapping the version segment inside `jira` would silently mis-map
every one of them — the correct shape is a second connector sharing
the mapping layer.

## Connector shape

- Same package `packages/jira` → connector **`jira-dc`** alongside
  `jira`. The deployment surface is a bound `JiraApi` (api.ts's
  `makeApi('cloud'|'dc')`); the whole TaskStore mapping
  (status/blocked/claim/deps/priority/type/trailer) is
  deployment-blind in `buildTasks(S)` and shared verbatim.
- `optIn: true` — same name-only rule as every sibling connector;
  `connectors.tasks = "jira-dc"` picks it.
- Transport stays `atlassian api` exclusively — the connector spawns,
  never reads tokens.

## Surface deltas (v3 → v2)

- **Endpoints** — `/rest/api/2` prefix; no `/ex/jira/<cloudId>`
  gateway family (a DC site is always a base).
- **Site base required** — no api.atlassian.com default exists for
  DC; `JIRA_DC_BASE_URL` → `JIRA_BASE_URL`/`ATLASSIAN_BASE_URL` → the
  CLI's config `baseUrl` resolve the site, in that order. Nothing
  resolving throws instead of letting v2 calls land on Cloud.
  `JIRA_DC_BASE_URL` exists so a rig running both connectors can pin
  two sites.
- **Auth** — unchanged channel: `ATLASSIAN_TOKEN` is the env override
  and `atlassian api` sends it `Bearer` whenever the CLI's own config
  isn't token-mode — a DC personal access token is exactly that
  Bearer. A Cloud token-mode config (Basic email:api-token) does not
  authenticate DC; the /myself probe surfaces it honestly.
- **Users** — `name` (with `key` as the older alias): /myself
  validates it, assignee writes send `{name}`, unassign is the same
  `-1` sentinel, assignable-search takes `username=` (not `query=`).
- **Bodies** — description and comments are plain strings; `doc()`
  passes text through where Cloud wraps it in ADF. `adfText` already
  degrades v2 strings on read, so the trailer survives verbatim.
- **Search** — `POST /search {jql, fields, maxResults, startAt}` →
  `{issues, total}`; the normalized page cursor is the next startAt.
- **Projects** — `GET /project` (full array) for the single-project
  fallback; the `JIRA_PROJECT` direct key read is identical.
- **Same everywhere** — transitions, issueLink/issueLinkType,
  issuetype, priority, labels, resolution: identical v2 shapes.

## Acceptance

- `connectors.tasks="jira-dc"` + a DC-pinned site + a PAT in
  `ATLASSIAN_TOKEN` serves the same `bro next`/`bro loop`/`bro task`
  surface as `jira`.
- A DC pin on the `jira` connector (or a Cloud default on `jira-dc`)
  fails loud at /myself or endpoint resolution — never a quiet
  wrong-surface read.
- `bro doctor` shows `tasks: jira-dc` or the remediation line.
- Tests: v2 endpoint prefix, string comment/description bodies,
  `{name}` assignee write + verify + `-1` unassign, `username=`
  assignable search, `startAt`/`total` paging, `/project` array
  listing, name-keyed viewer identity, missing site base refuses.

## Honest absences

- `publish` — same as `jira`.
- http:// DC bases — the https rule holds (the CLI sends its
  Authorization header to the named host); an http-only intranet
  instance is exactly where a PAT must not go plaintext.
