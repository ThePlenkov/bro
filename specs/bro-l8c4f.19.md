# bro-l8c4f.19 — integrations docs surface existing task backends

Docs-integration-discoverability (audit 2026-10-18). The audit found
`integrations.md` explaining the task facade only through beads/store and
`packages.md` missing Linear/Jira — both gaps have since been partially
closed by later doc work. What remained at implementation time:

- `integrations.md` had no GitLab **tasks** backend section even though
  `connectors.tasks = "gitlab"` shipped (PR #834) and gained contract
  coverage (PR #1119).
- The facade→connector matrix `tasks` row omitted `gitlab`.
- `packages/jira/README.md` had no link to the public docs guide (every
  sibling connector README carries one).
- `packages/gitlab/README.md` and `packages.md` still described gitlab as
  reviews-only.

## Changes

- `site/content/docs/integrations.md`
  - New **GitLab tasks** subsection under Task backends: name-only opt-in
    (`connectors.tasks = "gitlab"`), `glab` auth, project resolution from
    the origin remote / `GROUP/PROJECT` arg, self-hosted via remote host or
    `GITLAB_HOST`, capabilities (TaskStore over Issues incl. claim protocol,
    close/reopen, links), honest absences (`deps()` unsupported, create
    rejects parent/deps, update rejects status/assignee, link rels limited
    to related/blocks/is_blocked_by with no cross-project, premium-only
    `blocked` flag — `blocked` label is the portable marker, `publish` not
    implemented).
  - Capabilities matrix `tasks` row gains `gitlab`.
- `site/content/docs/packages.md` — gitlab row mentions the opt-in `tasks`
  facade alongside `reviews`.
- `packages/jira/README.md` — `## Links` section pointing at
  broject.dev/docs/integrations, source, and the CLI package (matching the
  gitlab/github/linear README shape).
- `packages/gitlab/README.md` — intro/Surface updated: the connector now
  carries `reviews` + opt-in `tasks`; the "install only for reviews
  backends" hint widened accordingly.

## Acceptance (from the bead)

- Opt-in selection, auth/prerequisites, version availability and honest
  absences documented for the gitlab tasks backend — including Jira
  publish (already documented; unchanged).
- Package READMEs lead to the public guides — jira gains the missing
  link; gitlab description corrected.

## Verification

- `npm run check:docs` (repo docs gate)
- `npm run check:command-docs` if command surface touched (not expected —
  docs-only change)
- Manual review that every claim matches `packages/gitlab/src/tasks.ts`
  and `specs/bro-l8c4f.16.md`.
