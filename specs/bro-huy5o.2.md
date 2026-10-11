---
parent: bro-huy5o
scope:
  - packages/core/src/taskmeta.ts
  - packages/core/src/index.ts
  - packages/github/src/tasks.ts
  - packages/linear/
  - packages/cli/src/plugins.ts
  - package-lock.json
---

# bro-huy5o.2 — tasks connector: linear

Parent: `bro-huy5o` (epic — adoption-first connector backlog). Sibling of
`bro-huy5o.1` (github-issues tasks).

## Problem

The `tasks` facade has two backends — beads (the default) and github-issues
(bro-huy5o.1). Teams whose work items live in Linear get no `bro next` /
`bro loop` / `bro task` surface at all. Linear's GraphQL API carries every
primitive the TaskStore contract needs — workflow states, assignee, labels,
parent/sub-issue structure, and directional `blocks` relations — plus a
personal-API-key auth model (`LINEAR_API_KEY`) that needs no CLI install
beyond `curl`.

The bead also asks for a `queries` facade so `kind = "query"` plans can
name `provider = "linear"` and fan out to Linear next to
github/gitlab/atlassian (bro-14h8.1).

## Transport

Linear has no official CLI and no self-hosted tier — the transport is plain
HTTPS to the fixed endpoint `https://api.linear.app/graphql`:

- **Sync path** (`TaskStore`): `curl -sS --fail-with-body` with the JSON
  body on stdin (`--data-binary @-` — the payload never enters argv) and
  the `Authorization` header on `-H @file` (0600, private tmpdir, spawn
  lifetime — every local user can `ps` argv, so neither secret rides it).
  The TaskStore contract is synchronous, so the sync path needs a blocking
  transport; `curl` is the same "shell to the system's own tool" precedent
  as `gh`/`glab`, and ships on every platform bro runs on.
- **Async path** (`TaskStoreAsync`, `queries` facade): native `fetch`
  (Node ≥22), injectable for tests (`FetchFn` seam, same as
  `@broject/providers`).
- **Auth**: `Authorization: <LINEAR_API_KEY>` verbatim — Linear personal
  API keys are used directly, not as a Bearer token. The key reads from
  `process.env` (plus the query-plan `env` overlay for the `queries`
  facade — literal pass-through like `GH_HOST`/`GITLAB_HOST` on the CLI
  providers). The endpoint is hardcoded, so no `LINEAR_API_URL`-style
  redirect exists for plan `env` to abuse; a plan *may* set
  `LINEAR_API_KEY` itself — same "literal overlay is the author's own
  credential choice" posture as `ATLASSIAN_TOKEN` in bro-14h8.1.

## Selection

- `connectors.tasks = "linear"` in bro.config picks the store by name;
  `connectors.queries = "linear"` or a step's `provider = "linear"` picks
  the data plane. Pair with `stores: ["jsonl"]` for the zero-install shape.
- `optIn: true` on the connector — nothing about a repo's remote or
  layout implies Linear, so every facade is name-only (the atlassian
  precedent).
- Default stays beads — unchanged.

## Scope: the team

A Linear task store is one team's queue. Resolution order:

1. `LINEAR_TEAM` env — a team key (`ENG`, case-insensitive) or UUID.
2. Unset + exactly one team visible to the key → that team (the
   adoption-first shape: a one-team workspace needs zero config).
3. Unset + several teams → error listing the team keys and asking for
   `LINEAR_TEAM`. Ambiguity fails loud, never picks.

`prefix()` returns the resolved team's `key` — Linear identifiers are
literally `<KEY>-<n>`, which slots straight into `bro next`'s
`issue_prefix` scoping. A failed teams probe throws (fail closed, same
contract as beads).

## Mapping (Issues → TaskStore)

Reuses the github-issues mapping (spec bro-huy5o.1) where Linear has no
native field; Linear-native fields win where they exist:

- **id** — the issue identifier (`ENG-123`); accepted forms `ENG-123`,
  `123` (resolved inside the configured team), `https://linear.app/<ws>/issue/ENG-123/…`
  URLs, and the UUID.
- **status** — `state.type` `completed`/`canceled` → `closed`; `started`
  or any assignee → `in_progress`; open + blocked → `blocked`;
  else `open` (`backlog`/`unstarted`). `triage` maps to `blocked` —
  Linear triage is "not yet approved", which is exactly "cannot start";
  it must not be claimable. Archived issues map to `closed` (list
  queries exclude them by default anyway).
- **blocked** — an open issue is blocked when an incoming `blocks`
  relation (`inverseRelations` where type=blocks — Linear relations are
  directional: `issue` blocks `relatedIssue`) names an issue whose own
  state isn't terminal, when it has an open sub-issue (decomposed work is
  not itself ready), or when it carries a manual `blocked` label.
- **ready** — open + unblocked + unassigned, ordered priority asc then
  created asc (same as github-issues).
- **claim** — assignee IS the claim (Linear-native: no `bro:claimed`
  label). Read → `issueUpdate{assigneeId: viewer.id}` → re-read verify.
  A contested assignee resolves to the holder the verify-read shows:
  winner keeps it, loser throws `claim contested — <holder> holds it`.
  Single-assignee writes make the winner sole holder — no unassign step.
- **close** — reason lands as a `commentCreate` first (fails → not
  closed), then `issueUpdate{stateId: first 'completed' state}` of the
  issue's own team. `close_reason` reads `canceled`/`archived` state
  back.
- **reopen** — terminal states move to the team's first `unstarted`
  state (fallback `backlog`); every open issue only gets its assignee
  cleared. The release runs either way, same as github.
- **type / external_ref / metadata** — Linear has no issue-type field:
  `type:<t>`/`kind:<t>`/`epic` labels win, then the
  `<!-- bro: {...} -->` description trailer (the helpers are extracted
  from `packages/github/src/tasks.ts` into `packages/core/src/taskmeta.ts`
  — the trailer format is a cross-backend contract, one implementation).
  The trailer is the description's last element — a `bro:` comment
  inside the prose is an example, not metadata.
  `external_ref` reads the trailer first, then the issue URL.
- **priority** — native `priority` field, name-mapped onto bd's 0–4
  lower-is-urgent scale: urgent(1)→0, high(2)→1, medium(3)→2, low(4)→3,
  none(0)→4. Writes map back: 0→urgent, 1→high, 2→medium, 3→low, 4→none.
  Round-trips cleanly; verbatim numbers would put "no priority" at the
  head of `bro next`'s ascending queue.
- **children/deps** — `children` sub-issues; `deps` emits `blocks` edges
  from `inverseRelations`/`relations` and `parent-child` edges from
  `parent`/`children`, in bd's `{issue_id, depends_on_id, type}` shape
  with identifiers. `link(from,to,'blocks'|'blocked-by')` →
  `issueRelationCreate{issueId: to, relatedIssueId: from, type: 'blocks'}`
  (from is blocked by to); `'parent-child'` → `issueUpdate{parentId}`.
  Other types throw — never faked. A sub-issue's parent is NOT mapped to
  `row.parent` (same reason as github: `row.parent` means orchestrated
  step in the contract; a Linear sub-issue must stay claimable — its
  parent is already un-ready while the sub-issue is open).
- **labels** — read via `labels.nodes`; writes resolve label names →
  team label ids, creating missing ones via `issueLabelCreate`
  (github's `ensureLabel` analogue). `update` label keys merge — Linear's
  `labelIds` replaces the full set, so existing ids survive.
- **remove** — `issueDelete` (Linear's real delete; goes to trash).
- **note** — `commentCreate`.
- **actor** — `viewer { displayName }` (fallback `email`), cached per
  process. Row `assignee` reads `assignee.displayName`.

## `queries` facade

`linearQueries()` implements `QueryFacade.graphql(doc, {vars, env})` —
POST `{query, variables}` to the fixed endpoint over fetch, return
`{data?, errors?}` verbatim (the atlassian contract: raw passthrough, no
normalization). `vars` carries typed JSON — unlike the CLI providers
there is no `-f` scalar flattening. A missing key throws
`linear: LINEAR_API_KEY not set`, landing as the step's `error` in the
merged plan result — never a crash of the plan itself.

## Absent capabilities

Same set as github-issues: mols/convoy, mesh, drill frames, provenance,
`bro task exec`, `next --global` keep requiring bd — untouched
`checkBeads` call sites. `next`, `loop`, `bro task` verbs, `work enter`,
the stop-gate task probe all resolve through `facade('tasks')` and gate
on the connector's `auth()`: `LINEAR_API_KEY` set + `curl` on PATH →
null; else the remediation line (`set LINEAR_API_KEY — Linear → Settings
→ Security & access` / `install curl`). Doctor's `tasks` row shows the
probe output through the existing `facadeAuth` path — no doctor changes.

## Acceptance

- `connectors.tasks="linear"` + `LINEAR_API_KEY` + `LINEAR_TEAM` (or a
  single-team workspace): `bro next`, `bro loop --dry-run`, `bro task`
  verbs, and the stop-gate probe work with no `bd` present.
- A `kind = "query"` plan step with `provider = "linear"` returns the
  Linear GraphQL response in the merged JSON; a missing key lands as a
  per-step `error`.
- `bro doctor` shows `tasks: linear` ok or the auth remediation line —
  never a crash.
- Tests: status/type mapping per workflow-state type, blocked via
  inverseRelations + open children + label, ready ordering on the
  mapped priority scale, claim read→write→verify incl. contested,
  close/reopen state writes, link edge directions, LINEAR_TEAM
  resolution (env pick, single-team auto, ambiguity error), opt-in
  selection, queries facade passthrough + auth error.
