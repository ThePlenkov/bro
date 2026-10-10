---
parent: bro-huy5o
scope:
  - packages/debt/src/sonarcloud.ts
  - packages/debt/src/collectors.ts
  - packages/debt/src/index.ts
  - packages/core/src/config.ts
  - packages/cli/src/commands/debt.ts
  - packages/cli/src/commands/doctor.ts
  - README.md
  - skills/debt/SKILL.md
---

# bro-huy5o.4 — debt source: sonarcloud

Parent: `bro-huy5o` (epic — adoption-first connector backlog).

## Problem

Most rigs run SonarCloud Automatic Analysis: every merged branch carries
a stream of issues and security hotspots that no GitHub surface
(review threads, code-scanning alerts, dependabot) reports. `bro debt
collect` never sees them — the debt exists upstream but is invisible to
the ledger and the beads queue.

## Source

`sonarcloud` joins `debt.sources` next to the GitHub alert feeds. One
collector, two endpoints on the project:

- `GET {host}/api/issues/search?componentKeys=<key>&resolved=false&sinceLeakPeriod=true`
  — open issues on new code (the leak period: findings merged work
  introduced, not the project's whole backlog).
- `GET {host}/api/hotspots/search?projectKey=<key>&status=TO_REVIEW&sinceLeakPeriod=true`
  — security hotspots awaiting review on new code.

Findings are project-scope, like the other alert sources: `thread_id`
is `sonarcloud:<issueKey>` / `sonarcloud:hotspot:<key>`, stable across
runs so the ledger's thread_id upsert dedups re-collects. Severity maps
onto `DebtPriority` — BLOCKER/CRITICAL and HIGH hotspot probability →
`blocking`, MAJOR/MEDIUM → `scan`, MINOR/INFO/LOW → `nit`. The record's
`path` is the component path (key prefix stripped) and `line` the issue
line — both needed by dedupe below.

## Auth + project resolution

- **Token**: `SONAR_TOKEN` env, sent as
  `Authorization: Basic base64(<token>:)` — Sonar's token-as-username
  convention.
- **Transport**: `curl` GET (the sync collectors can't await; the
  `gh`/`glab`/linear precedent — no official sonar CLI exists). The
  Authorization header rides a 0600 file (`-H @file`) in a private
  tmpdir — never argv, every local user can `ps`.
- **Host + project key**, first match wins:
  `debt.sonarcloud.project_key` / `debt.sonarcloud.host` in bro.config →
  `sonar.projectKey` / `sonar.host.url` in `sonar-project.properties` or
  `.sonarcloud.properties` (both conventions — scanner config and
  Automatic Analysis; the former wins per key) at the checkout root →
  host defaults to `https://sonarcloud.io` (the `sonar.host.url`
  override makes SonarQube Server work too — same API).
- **Missing prerequisites skip, never fail**: no token or no resolvable
  project key throws `SourceSkipped` — collect prints
  `debt: sonarcloud skipped — <remediation>` and crucially does NOT run
  the upstream-resolve pass (an empty fetch on a skipped source would
  mark every live row done). `bro doctor` reports it as a
  `debt-sonarcloud` warn with the remediation hint; configured + healthy
  reports ok (`token set · project <key>`); unconfigured emits no row.

## Dedupe vs review-threads

SonarCloud also decorates PRs: when its GitHub app comments inline on a
merged PR, the review-threads sweep already harvested that comment as a
ledger row. Collecting the API issue as well would double-count the
finding. So before landing, each fresh sonarcloud record is dropped when
an **open review-thread row** (no `source` tag) covers it:

- same `path` and same `line` (both non-null), or
- the thread body contains the issue key (Sonar comments link back with
  `issues=<key>` / `hotspots=<key>` / `open=<key>`).

Bookkeeping:

- a previously collected sonarcloud row now covered → `duplicate`
  overlay (`covered by <thread_id>`), not `done` — the finding isn't
  fixed, it's owned by the thread row; fix% must not count it.
- a covered id is excluded from the "resolved upstream" sweep.
- coverage disappearing (the thread row resolves) re-emits the record on
  the next collect; a stale `duplicate` overlay is reopened to `open`.

## CLI

`bro debt collect --source sonarcloud` — a new `--source` CSV flag
overrides `debt.sources` for one run (all-invalid errors like
`--pr-ids`), satisfying the acceptance criterion without a config edit.

## Acceptance

- `bro debt collect --source sonarcloud` lands findings in
  `.agents/review-debt` with stable `sonarcloud:*` ids; a re-run is
  idempotent (thread_id upsert).
- `SONAR_TOKEN` unset → the source is skipped with a stderr remediation
  and a `debt-sonarcloud` warn row + hint in `bro doctor`; no ledger
  rows are swept.
- Dedupe: a sonar issue matching an open review-thread row (path+line or
  key in body) emits no second row; a previously landed row transitions
  to `duplicate`.
- Tests: issue/hotspot mapping, severity→priority, component→path,
  pagination, properties-file vs config precedence, missing-token skip,
  dedupe match/no-match, doctor rows.
