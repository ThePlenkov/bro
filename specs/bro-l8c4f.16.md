---
parent: bro-l8c4f
scope:
  - packages/gitlab/src/tasks.ts
  - packages/gitlab/src/index.ts
  - packages/gitlab/src/tasks.test.ts
  - packages/core/src/connectors.ts
---

# bro-l8c4f.16 — tasks connector: gitlab-issues (opt-in TaskStore)

Parent: `bro-l8c4f` (principal audit 2026-10-18). Sibling of
`bro-huy5o.1` (github-issues) and `bro-huy5o.2` (linear) — the same
"task store over the forge's own issues" pattern, on the `glab` CLI.

This spec is retroactive: the facade shipped in PR #834
(`packages/gitlab/src/tasks.ts`, wired `optInFacades: ['tasks',
'tasksAsync']`) ahead of its spec and fixtures. This document records
the contract as implemented; `tasks.test.ts` pins it.

## Problem

`bd` is bro's only `tasks` backend unless a connector provides the
facade. A repo hosted on GitLab gets `reviews`/`stacks`/`queries` from
the gitlab connector but no `bro next` / `bro task` / stop-gate task
probe without installing beads. GitLab Issues carries the primitives a
task store needs — iids, open/closed state, assignees, labels, issue
links — so a `tasks` facade on the gitlab connector makes a GitLab
clone a working bro rig with zero installs beyond `glab`.

## Selection — opt-in only

- `connectors.tasks = "gitlab"` in bro.config picks the facade by
  name. Pair with `stores: ["jsonl"]` for the zero-install shape.
- The facade is **name-only**: `optInFacades: ['tasks', 'tasksAsync']`
  on `gitlabConnector` (core `pickConnectorAuto` filters opted-in
  facades out of unnamed resolution — a gitlab remote claims
  `reviews`/`stacks`/`queries` by detection but must NOT flip a beads
  repo's task store. The github connector ships the identical pin for
  the same reason (spec bro-huy5o.1).
- A named pick bypasses the filter on any remote — an explicit
  `connectors.tasks` is an operator choice, not a detection.
- Default stays beads — unchanged.

## Transport

All API calls ride `glab api` (`glab.ts`): `glabJson` for reads,
`glabTry` for writes whose exit code carries meaning, `glabPaged` for
lists. `glab api` was chosen over `glab issue *` verbs because the
verbs' flags and output shapes drift across glab versions while the
REST resource paths are stable.

- **Project resolution** — the origin remote's path, verbatim:
  `https://`, `ssh://` and scp-style (`git@host:path`) remotes all
  parse; nested groups keep their slashes (`group/sub/proj` →
  `projects/group%2Fsub%2Fproj`). No remote (and no positional
  channel, which the TaskStore interface doesn't carry) →
  `no GitLab remote` — fail loud, never a silent default project.
- **Host pinning** — every spawn runs with `GITLAB_HOST =
  hostFor(dir)`: the origin remote's authority (port included when the
  URL carries one — `ssh://` user prefixes are stripped, ports stay),
  else the user's `GITLAB_HOST` env, else `gitlab.com`. A self-hosted
  remote therefore hits its own instance deterministically, not
  glab's configured default host.
- **Pagination** — `glabPaged` walks `?per_page=100&page=N` until a
  short page; `limit` stops collection early. List fetches run
  per-state (`state=opened`, `state=closed`); a filter needing
  post-filtering (labels/type/non-closed status) fetches up to
  `QUERY_CAP` (1000) per state, a plain list fetches only what
  `filter.limit` asks.
- **Failures propagate** — a nonzero `glab` exit throws
  `glab api failed: <stderr>`; it is never swallowed into an empty
  list. The single-issue read maps `404`/`not found` to `undefined`
  (a miss), but transport and auth failures rethrow — an outage must
  not masquerade as "task doesn't exist".

## Mapping (Issues → TaskRow)

- **id** — the project-scoped issue iid as a string (`'42'`).
  Accepted forms: `'42'`, `'#42'`, full issue URLs
  (`https://<host>/<path>/-/issues/<n>`), and cross-project
  `group/project#42` or `group/project:42`.
  - URL refs are **same-store-strict**: a URL whose host differs from
    `hostFor(dir)` throws `is from <host> — this store serves <host>`;
    a path differing from the remote's project throws
    `is for <path> — this store serves <project>`.
  - `#`/`:` refs are **permissive**: a path matching the current
    project (case-insensitive) resolves to it; a different path is a
    cross-project read that returns a row with the foreign id form
    `<projectPath>#<iid>` (`list`/`get` tag foreign rows this way;
    `link` rejects cross-project pairs).
  - Anything else — non-numeric, zero, negative — throws
    `not an issue reference`.
- **status** — `closed` ↔ `state=closed`; open + `bro:claimed` label
  or any assignee ↔ `in_progress`; open + blocked ↔ `blocked`;
  else `open`.
- **blocked** — an open issue is blocked when it carries a `blocked`
  label or the premium `blocked` flag is set on the issue entity
  (incoming open blockers). `blocking_issues_count` is deliberately
  NOT a signal: it counts the open issues this issue *blocks* — the
  outgoing direction — so a blocker is itself ready work. Free-tier
  REST exposes no incoming-blocker field; the label is the manual
  marker there, and `deps()` stays unsupported rather than fanning
  out a links read per row. There is no sub-issue probe — GitLab
  tasks are not decomposed through this facade.
- **ready** — open + unblocked + unassigned + unclaimed, ordered
  priority asc then `created_at` asc.
- **type / priority / metadata** — GitLab has no fields: `type:<t>` /
  `kind:<t>` / `epic` labels win, then the `<!-- bro: {...} -->`
  body trailer (`taskmeta.ts` — the cross-backend contract); `type`
  defaults `task`. Priority reads `p<N>`/`priority:<N>` labels then
  the trailer; default 2 (bd's default). Rows expose the trailer as
  `metadata`; `description` is the body with the trailer stripped;
  `external_ref` reads the trailer first, then `web_url`.
- **claim** — read → ensure `bro:claimed` label exists → resolve the
  actor's user id (`api user` → `users?username=`) →
  `PUT assignee_id` → re-read verify → `PUT labels=…,bro:claimed`.
  Check-then-act can't be atomic over REST: a contested assignee set
  resolves to the lexicographically smallest username — the loser
  unassigns itself (`assignee_id=0`) and throws
  `claim contested — <winner> holds it`; the label lands last so
  "label present ⇒ claim verified". Pre-claimed issues (label or any
  assignee) throw `already claimed` before any write; closed issues
  throw `only open issues are claimable`; an unresolvable viewer
  throws `claim needs a glab identity`.
  `claimCapability` declares `{best-effort, viewer, service}` — a
  marker, never a lease (spec bro-l8c4f.12).
- **close** — optional reason lands as a note
  (`POST issues/<iid>/notes`) first — a failed note aborts the close —
  then `PUT state_event=close`. **reopen** — `state_event=reopen`
  (skipped when already open), `assignee_id=0`, and the label set
  minus `bro:claimed`/`blocked`, so the issue re-queues.
- **create** — `POST projects/<p>/issues` with `title`, `description`
  (body + trailer via `withMeta`), `labels[]=` per label. `parent`/
  `deps` on the input throw `create does not support parent/deps` —
  GitLab has no dep write-back on create and a fake would lie.
- **update** — `PUT` field patch: `title`, `description`/`body`,
  `labels`/`label` only. `status`, `assignee`, and unknown keys throw
  — status moves through reopen/close, assignee through claim. An
  empty patch is a no-op call-wise.
- **link** — `related` and `blocked`/`blocks`/`blocked-by` map to
  `POST issues/<from>/links` (`link_type=blocks` for the blocked
  family; same-project targets only, with a `target_project_id`
  retry for API versions that require it). `parent`, `tracks`,
  `discovered`, and unknown rels throw
  `unsupported dependency operations explicitly rejected`.
- **note / remove** — `POST …/notes`; `DELETE issues/<iid>`.
- **prefix()** — the project name (last remote-path segment); a repo
  with no resolvable remote answers `undefined` instead of throwing.
- **Absent capabilities (thrown, never faked)** — `children`, `deps`,
  `neighbors` throw `not supported`: the facade writes issue links but
  does not read a dep graph back. `publish`, `getMany`, slots, sync —
  omitted entirely (optional capabilities the contract lets a store
  skip). The async surface (`tasksAsync`) is a thin delegation to the
  sync store — reads only (`list`/`ready`/`get`/`actor`), same thrown
  absents.

## Acceptance

- `connectors.tasks="gitlab"` + a gitlab remote: `list`/`ready`/`get`/
  `create`/`update`/`claim`/`reopen`/`close`/`note`/`link` serve real
  issue state through `glab api`.
- A gitlab remote alone never resolves `tasks` to gitlab — beads stays
  the default; the name-pin `connectors.tasks` resolves on any remote.
- Fixtures (`tasks.test.ts`): status mapping incl. blocked signals,
  ready ordering, `glabPaged` multi-page assembly, id forms (URL
  strict vs `#`-form permissive, cross-project foreign ids), nested
  groups + `ssh://` + scp-style + self-hosted remote parsing with
  `GITLAB_HOST` pinning, nonzero-glab propagation, claim incl.
  contested-race winner/loser, close/reopen endpoint writes,
  unsupported-op throws, opt-in resolution.
