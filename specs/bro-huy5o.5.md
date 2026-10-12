---
parent: bro-huy5o
scope:
  - packages/debt/src/codacy.ts
  - packages/debt/src/codescene.ts
  - packages/debt/src/collectors.ts
  - packages/debt/src/index.ts
  - packages/core/src/config.ts
  - packages/cli/src/commands/debt.ts
  - packages/cli/src/commands/doctor.ts
  - README.md
  - skills/debt/SKILL.md
---

# bro-huy5o.5 — debt sources: codacy + codescene

Parent: `bro-huy5o` (epic — adoption-first connector backlog).
Sibling: `bro-huy5o.4` (sonarcloud — the collector shape this spec mirrors).

## Problem

Two more hosted analysis services produce findings no GitHub surface
reports: **Codacy** keeps a per-repo issue list from its latest analysis
(style, error-prone, security, duplication), and **CodeScene** stores a
delta analysis ("Code Review") per PR its Git provider integration
reviews — failed quality gates and per-file code-health declines that
merged anyway are debt. `bro debt collect` sees neither.

## Source: codacy

`codacy` joins `debt.sources`. One endpoint on Codacy API v3:

- `POST {host}/api/v3/analysis/organizations/{provider}/{org}/repositories/{repo}/issues/search?limit=500&cursor=…`
  — the repo's current issues (Codacy keeps only the latest analysis's
  set; that IS the on-new-code issue list). Empty JSON body `{}` — all
  levels and categories. `provider`/`org`/`repo` resolve below; cursor
  pagination follows `pagination.cursor` until absent.

`thread_id` is `codacy:<issueId>` — stable across runs, so the ledger's
thread_id upsert dedups re-collects. `patternInfo.level` maps onto
`DebtPriority`: `Error`/`Critical` → `blocking`, `Warning`/`Major` →
`scan`, `Info`/`Minor`/absent → `nit`. `path` is `commitIssue.filePath`,
`line` is `lineNumber`, `createdAt` is `commitInfo.timestamp`.

## Source: codescene

`codescene` joins `debt.sources`. CodeScene's cloud API is read-only —
delta analyses are produced by CodeScene's own Git-provider PR
integration and read back via:

- `GET {host}/v2/projects/{projectId}/delta-analyses?page=N`
  → `{ page, max_pages, delta_analyses: […] }` — pages follow
  `max_pages` (capped; an over-cap result set fails the source rather
  than return a partial list the upstream-resolve sweep would trust).
- `GET {host}/v2/projects/{projectId}/delta-analyses/{id}`
  — detail; `file_results[]` is detail-only (list items omit it).

A delta analysis is a finding when `failed_gates` is non-empty or
`code_health < old_code_health`. Only those get a detail fetch. Records:

- per truthy gate in `failed_gates` (an object `{<gate>: true|details}`;
  arrays/strings tolerated): `codescene:<id>:gate:<gate>` → `blocking`,
  no path.
- per `file_results[]` entry with `code_health < old_code_health`:
  `codescene:<id>:file:<path>` → `scan`, `line` null, body carries
  `<old> → <new>`.

`thread_id`s embed the delta analysis id — a delta verdict is immutable
history, so rows persist until a fix verdict or the `duplicate` overlay;
the upstream-resolve sweep only fires if CodeScene stops returning the
analysis. `createdAt` is `analysistime` (epoch s/ms or ISO — liberal
parse, harvest time fallback), `author` the first `authors[]` entry.

## Auth + resolution

Same transport contract as sonarcloud: `curl` via `spawnSync` (sync
collectors, no official CLI), the credential header rides a 0600 file
(`-H @file`) in a private tmpdir — never argv. `https` only, except
loopback `http` (self-hosted dev rigs); a custom host is trusted because
it comes from `debt.sourceConfig.<source>.host` — the same config trust
layer as sonarcloud; neither source reads host config from committed
repo files, so no ambient-content token-leak path exists.

- **codacy**: `CODACY_API_TOKEN` → `api-token:` header (account token),
  or `CODACY_PROJECT_TOKEN` → `project-token:` (repo-scoped token).
  `provider` = `debt.sourceConfig.codacy.provider`, default `gh` (the
  facade's provider codes match: `gh/ghe/gl/gle/bb/bbe`); `org`/`repo`
  are `ctx.repo` (`owner/name`) — Codacy names repos by their Git
  provider coordinates, so no extra mapping exists. Host default
  `https://api.codacy.com`; UI links use `https://app.codacy.com` for the
  default host, the configured host otherwise.
- **codescene**: `CODESCENE_TOKEN` → `Authorization: Bearer` header.
  `project_id` = `debt.sourceConfig.codescene.project_id` (number or
  string) → `CODESCENE_PROJECT_ID` env → skip with remediation ("the
  number in codescene.io/projects/<id>"). Host default
  `https://api.codescene.io`; UI links `https://codescene.io`.
- **Missing prerequisites skip, never fail**: absent token / project id
  throws `SourceSkipped` — collect prints
  `debt: <source> skipped — <remediation>` and does NOT run the
  upstream-resolve pass. `bro doctor` reports `debt-codacy` /
  `debt-codescene` warn rows with remediation hints; configured +
  healthy reports ok; unconfigured emits no row.

## Dedupe vs review-threads

Both services decorate PRs — Codacy's GitHub integration posts inline
comments, CodeScene posts its Code Review verdict — so merged-PR sweep
rows can already carry the same finding. The sonarcloud dedupe
mechanism generalizes: `dedupeByThreads` in collectors.ts runs the
open-review-thread coverage loop; each source supplies a `covers`
predicate:

- **codacy**: same `path`+`line` (both non-null), or the thread body
  links back with the issueId as a whole token in `?`/`&` —
  `issueId=<id>` / `issues=<id>`.
- **codescene**: the thread body names the delta analysis —
  `delta-analysis/<id>` or `delta-analyses/<id>` (path-only matching is
  deliberately NOT used: file-level findings have no line to
  disambiguate, so a human comment on the same file must not suppress
  the finding).
- **sonarcloud** keeps its predicate (`dedupeReviewThreads` delegates to
  `dedupeByThreads`).

Bookkeeping rides the existing `syncDedupeOverlays` (renamed from
`syncSonarDedupeOverlays` — the mechanism was never sonar-specific):
covered open/done rows → `duplicate`, stale `duplicate`/`done` on a
re-emitted finding → `open`, `wontfix` stays; covered ids are excluded
from the resolved-upstream sweep.

## CLI + config

- `bro debt collect --source codacy` / `--source codescene` — the
  `--source` CSV flag from .4 already overrides `debt.sources`; the new
  names just join `ALL_SOURCES`.
- `debt.sourceConfig.codacy.{host,provider}` /
  `debt.sourceConfig.codescene.{host,project_id}` — verbatim per-source
  bags, field validation in the collectors.

## Acceptance

- `bro debt collect --source codacy` lands `codacy:*` rows with stable
  ids; `--source codescene` lands `codescene:*` gate + file rows;
  re-runs are idempotent (thread_id upsert).
- Missing tokens / project id → stderr remediation + `debt-codacy` /
  `debt-codescene` warn in `bro doctor`; no ledger sweep.
- Dedupe: a Codacy issue matching an open review thread (path+line or
  issueId link) and a CodeScene delta whose id appears in a thread body
  emit no second row; previously landed rows transition to `duplicate`.
- Tests: issue→record mapping, level→priority, cursor pagination,
  provider/host config, missing-token skip, delta→gate/file mapping,
  analysistime parsing, page/max_pages follow + over-cap refusal,
  dedupe match/no-match per source, doctor rows.
