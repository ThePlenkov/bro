# bro-00t — Second connector (GitLab) to prove the Connector seam

## Problem

The connector model (Connector + FacadeMap + facade resolution) shipped
in #101-#107 with exactly one review-host implementation —
`@broject/github` over `gh`. An abstraction with one impl is a bet, not
proven flexibility: vendor assumptions can hide in the contract (`repo`
as `owner/name` — GitLab project paths nest), in facade semantics
(`mergeable`, `checks`, "reviewed SHAs"), or in helpers (`gh.ts` is the
only vendor shell). A second connector validates — or corrects — the
seam while it is still cheap to change.

## Design

`@broject/gitlab` — a review-host connector over the `glab` CLI,
mirroring `@broject/github` one-for-one. `glab api` (authenticated REST
passthrough, same role as `gh api`) reaches GitLab REST v4, so no
GraphQL schema is needed. The mapping:

- **repo**: `PrTarget.repo` stays a path string — GitLab's
  `group/sub/project` nests, so `resolveRepo` parses the origin remote's
  full path and positionals join with `/`. API endpoints URL-encode it
  (`projects/<enc>`).
- **threads** ⇐ MR discussions: only resolvable, non-system discussion
  notes count (individual notes are issue-style comments, not threads).
  `resolved` = all resolvable notes resolved; `outdated` = the first
  note's `position.head_sha` differing from the MR's
  `diff_refs.head_sha` (the REST `active` flag isn't reliably
  serialized — it's only the fallback when a sha is absent).
  resolve/unresolve = `PUT …/discussions/:id` with `resolved=`; reply =
  `POST …/discussions/:id/notes`.
- **checks** ⇐ jobs + bridges of the pipeline whose `sha` matches the
  MR head, `status` → bucket map — a stale-commit pipeline is not the
  current check state, so no match means `[]`. GitLab has no per-job
  required flag — pipeline success is a project-level merge gate, so
  `requiredOnly` returns all.
- **checkAnnotations** ⇐ `new Map()` — GitLab has no annotations
  endpoint; an absent key already means exactly that in the contract.
- **reviewedShas** ⇐ MR diff versions' `head_commit_sha` — the pushes
  that entered review.
- **mergeable** ⇐ `detailed_merge_status`: `conflict`→CONFLICTING,
  `checking|unchecked|broken_status`→UNKNOWN, everything else→MERGEABLE.
  The domain contract is "no merge conflicts" — CI pending, unresolved
  discussions and missing approvals are gated by their own signals.
  `mergeState`: `need_rebase`→BEHIND, else the status uppercased.
- **merge** ⇐ `PUT …/merge` with `sha` (the expectedHeadSha pin — a
  moved head answers 409) + `squash=true` for the squash method; a
  re-GET returns the authoritative post-merge state (auto-merge holds
  surface as non-MERGED). The endpoint has no merge-method param —
  merge-vs-rebase is project config (`merge_method` there), so
  non-squash `method`s land the project's way. No `admin` bypass
  param either — the flag is ignored.
- **updateBranch** ⇐ head-sha check, then `PUT …/rebase`. GitLab's only
  update mechanism rebases rather than merging base into head; the
  response is async-accepted, which is fine — the caller re-polls.
- **mergedPrs/mergedPrInfo/labels/prUpdatedAt** ⇐ direct REST.
- **labelPrs** ⇐ pooled `PUT …/merge_requests/:iid` with
  `add_labels`/`remove_labels` — the response already carries
  `updated_at`, so no re-query is needed.
- **scanMergedPrs** ⇐ pooled per-MR REST (GitLab has no aliased bulk
  query; the pool still overlaps the two calls per MR).
- **auth** ⇐ `glab auth status` (`--hostname` for non-gitlab.com hosts).
- **matchRemote** ⇐ `gitlab.com` + `*.gitlab.com` only — the same
  lookalike rule as github; self-hosted instances resolve via
  `connectors.reviews` config. All `glab` calls run `cwd=dir` with
  `GITLAB_HOST` pinned to the detected remote host (or the user's own
  `GITLAB_HOST` when the dir has no remote) — glab's in-repo detection
  would usually agree, but the pin makes configured self-hosted setups
  deterministic; `prLink`/`parsePrRef` bind the same host.

Seam verdicts (no core changes needed):

- `repo` survived as an opaque path — the doc comment's `owner/name`
  wording was the only GitHub-ism.
- Optional facade members degrade cleanly: `checkAnnotations` empty and
  `scanMergedPrs`/`labelPrs` absent-or-partial are already contractual.
- `pooled`/`chunks` duplicate per-vendor (~15 lines) — left per-package;
  a third connector would argue for core.
- `tasks` stays unprovided — absence is honest, beads remains default.

## Plan

- [ ] `packages/gitlab` — package scaffold + `glab.ts` shell helpers
- [ ] `reviews.ts` — full ReviewFacade over `glab api`
- [ ] `index.ts` — `gitlabConnector` (matchRemote/auth/reviews)
- [ ] `reviews.test.ts` — fake-glab harness mirroring the github suite
- [ ] `cli/plugins.ts` — register after github (registry order = fallback)
- [ ] publish.yml lockstep + publish-order lists, CONTRIBUTING.md layout,
      README `connectors` blurb
- [ ] `npm test` + typecheck green, PR
