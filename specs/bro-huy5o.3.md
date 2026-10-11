---
parent: bro-huy5o
scope:
  - packages/jira/
  - packages/cli/src/plugins.ts
  - package-lock.json
---

# bro-huy5o.3 — tasks connector: jira (over the atlassian CLI)

Parent: `bro-huy5o` (epic — adoption-first connector backlog). Sibling of
`bro-huy5o.1` (github-issues) and `bro-huy5o.2` (linear).

## Problem

Teams whose work items live in Jira get no `bro next` / `bro loop` /
`bro task` surface. The `atlassian` connector (bro-14h8.1) already wraps
the operator's `atlassian` CLI for `queries`, and that CLI ships a raw
REST passthrough — `atlassian api <METHOD> <endpoint> -d <json> --json` —
which reaches the whole Jira Cloud REST surface: JQL search, issue
links, transitions, assignee, comments. A `tasks` facade on top makes a
Jira project a working bro rig with zero installs beyond `atlassian`.

## Connector shape

- New package `packages/jira` → connector **`jira`**. The system is
  Jira; `atlassian` stays the cross-product `queries` provider (its spec
  already splits systems out of the query package as they land).
- `optIn: true` — every facade is name-only. Nothing about a repo's
  remote or layout implies a Jira site; `connectors.tasks = "jira"`
  (plus `stores: ["jsonl"]` for the zero-install shape) picks it.
- Transport is `atlassian api` exclusively — one uniform verb. The
  `atlassian jira` sugar commands are unsuitable (`jira search` prints
  decorated, unparseable output; `jira link` wants a site-specific
  numeric `--link-type-id`).
- Credentials stay the CLI's own (`atlassian auth login`,
  `ATLASSIAN_TOKEN`) — the connector spawns, never reads tokens.

## Endpoint resolution

`atlassian api` prefixes the endpoint with `baseUrl` =
`--url` → `config.baseUrl` → `https://api.atlassian.com`. Two endpoint
families cover both site shapes:

- `JIRA_BASE_URL` (env) → passed as `--url` (must be `https:` — the CLI
  sends Authorization to whatever it names) + plain `/rest/api/3/…`
  paths. Also the self-hosted / Data Center escape hatch.
- No env → read `~/.atlassian-tools/config.json` (the CLI's own config,
  read-only — endpoint resolution only, never credentials):
  `baseUrl` set → plain `/rest/api/3/…`; else `cloudId` (or
  `JIRA_CLOUD_ID`/`ATLASSIAN_CLOUD_ID` env) →
  `/ex/jira/<cloudId>/rest/api/3/…` gateway paths; neither → plain paths
  and the CLI's own failure surfaces.

## Scope: the project

A Jira task store is one project's queue — `JIRA_PROJECT` (or the CLI's
own `ATLASSIAN_PROJECT`) names it. Unset + exactly one visible project
(`GET /rest/api/3/project/search`) → that project; several → error
listing keys (the LINEAR_TEAM rule). `prefix()` returns the project key
— Jira keys are literally `<KEY>-<n>`, the `issue_prefix` slot-in.

## Mapping (Issues → TaskStore, same contract as github-issues)

- **id** — `PROJ-123`; accepted forms `proj-123`, bare `123` (serving
  project's key), `/browse/PROJ-123` URLs. Cross-project keys are
  in-scope (Jira links cross projects).
- **status** — `statusCategory.key`: `done` → closed; `indeterminate` →
  in_progress; `new`/other → in_progress when an assignee holds it,
  blocked when blocked, else open.
- **blocked** — open `Blocks` inward link (is-blocked-by a live issue),
  open sub-task (decomposed work is not itself ready), `blocked` label.
- **ready** — open + unblocked + unassigned, ordered mapped-priority asc
  then created asc. JQL narrows (`project = K AND statusCategory != Done
  AND assignee is EMPTY`); the derived-status filter is post-fetch like
  its siblings.
- **claim** — assignee IS the claim: read →
  `PUT /issue/<k>/assignee {accountId: viewer}` → verify re-read.
  Single-assignee writes settle races: the verify shows the sole holder;
  a loser throws `claim contested — <holder> holds it`.
- **close** — reason lands as an ADF comment first (fails → not closed),
  then the first available transition whose `to.statusCategory` is
  `done`. None → honest error, never a fake.
- **reopen** — terminal issues take the first transition whose target
  category is `new` (fallback `indeterminate`); the assignee is cleared
  and the `blocked` label dropped either way — same release-markers
  guarantee as github.
- **type** — Jira HAS issue types: `issuetype.name` wins (lowercased),
  then `type:`/`kind:`/`epic` labels, then the description trailer —
  github's ordering. Creates resolve the requested type case-
  insensitively against `GET /issuetype`; an unmapped name (bd's
  `chore`/`debt`) falls back to `Task` and keeps the verbatim name in
  the trailer's `type` — intent is never silently eaten.
- **priority** — positional over the site's ordered priority list
  (`GET /priority`): `Highest→0 … Lowest→4` falls out of the default
  5-name scheme; a custom scheme maps by position, so a round-trip is
  deterministic without hardcoding names. Unmatched/absent → trailer →
  default 2.
- **children/deps** — `subtasks`/`parent` are parent edges;
  `issuelinks` map by link-type name: `Blocks` → `blocked` (inward is
  the blocker), `Relates` → `related`, other site names pass through
  lowercase. `link(a,b,'blocked')` → `POST /issueLink` with
  outwardIssue=b ("b blocks a"); `link(a,b,'related')` resolves the
  site's relates-type via `GET /issueLinkType`; `link(a,b,'parent')` →
  `PUT fields.parent`. Unknown rels that match no link type throw.
- **metadata** — `<!-- bro: {...} -->` trailer lives in the description,
  written/read through minimal ADF↔text helpers (v3 descriptions are
  Atlassian Document Format; the trailer rides a plain paragraph).
- **actor** — `GET /myself` → `displayName` (fallback `emailAddress`);
  `accountId` is the claim identity. Cached per process.
- **remove** — `DELETE /issue/<key>` (Jira's real delete); **note** —
  `POST /issue/<key>/comment` with an ADF body.
- **publish** — absent (same as linear: no outward read-model asked for
  yet). `sync`/`dataDir`/`init`/`slot` absent — remote backends sync on
  write.

## Auth probe

`auth()` = binary on PATH + a live `GET /myself` under a tight budget —
one call covers binary, credentials, and endpoint resolution; the
remediation line names `atlassian auth login` (or the missing binary).
Never throws — doctor prints the line.

## Async surface

`tasksAsync` is the same reads over non-blocking `atlassian` spawns
(the `atlassian gql` precedent) — hook sweeps overlap instead of
serializing through the event loop.

## Acceptance

- `connectors.tasks="jira"` + `stores:["jsonl"]` + an authenticated
  `atlassian` CLI: `bro next`, `bro loop --dry-run`, `bro task` verbs,
  and the stop-gate task probe work with no `bd` present.
- `bro doctor` shows `tasks: jira` or the remediation line — never a
  crash.
- Tests: status/type mapping per statusCategory + issuetype, blocked via
  inward Blocks link + open subtask + label, ready ordering on the
  positional priority scale, claim read→assign→verify incl. contested,
  close/reopen transition picks, link edge directions + link-type
  resolution, project resolution (env pick, single-project auto,
  ambiguity error), opt-in selection, endpoint families (baseUrl /
  cloudId / explicit --url).
