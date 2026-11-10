---
parent: sdd
---

# bro-y1jtm — bro spec: product specs facade — KEY-N ids, lifecycle, conformance gate

## Problem

A spec is the textual representation of the product, not a ticket or a
completed change record. Code must conform to it; divergence in either
direction is a defect. Beads track changes; a PR decides which side is
wrong and changes the spec and code together. bro must provide this SDD
workflow to any repository, not just encode bro's own conventions.

The supplied audit baseline shows the current model failing that purpose:
approximately 290 spec Markdown files are mostly per-bead change records;
none has a status field. `bro spec drift --all` reports 209/293 STALE
because any later commit in scope counts as drift, producing noise rather
than conformance evidence. `bro spec check --all` finds 198 beads without
specs, while only 16 beads have `spec_id`. These are audit observations,
not counts promised to remain constant. `specs/README.md` calls a spec a
"decision record", contradicting the SDD skill and `SpecStore` description
of specs as "what the project now is".

The existing facade in `packages/core/src/specs.ts` supplies `hasSpec`,
optional scaffold/scope, remedy, policy and tree. Native, speckit, openspec
and agent connectors live in `packages/cli/src/spec-connectors.ts`.
The native index currently treats Markdown children as specs and identifies
them by bead/file names. Those mechanics must evolve without moving tool
knowledge into core or forcing other tools to adopt the native format.

## Design

### Product model and identity

- Specs persist through bead closure. Stored status is only product
  lifecycle: `draft | active | deprecated | removed`. Never archive a spec
  because implementation finished. It leaves the live tree only when the
  feature is removed: record `removed` in git before deleting its files;
  history retains the identity, aliases and removal. Deprecation is not
  removal; a deprecated feature still has a live spec and ownership.
- Changes are beads linked to a product spec; one spec may outlive many
  beads. Decision history is the spec's git history plus optional
  `decisions/NNN-*.md` subfiles, not another ticket-shaped spec series.
- Human IDs are Jira-shaped `KEY-N`, e.g. `BRO-12`. `sdd.key` configures
  the key; default is a deterministic uppercase repo-name-derived key,
  normalized to letters/digits starting with a letter. Empty/invalid
  derivations require explicit config. IDs use positive decimal numbers;
  compare parsed numbers, never lexical ordering. A derived key is not
  re-derived forever: on first allocation it is persisted to project
  config (`sdd.key`), so a later repository rename keeps the existing
  namespace instead of forking one product's identities across two keys.
- Allocate `max + 1` over allocated numbers on main, including removed
  identities in history, and account for new local allocations in the
  same batch. No distributed allocator: product specs are few. CI compares
  against current main and enforces uniqueness; competing branches that
  allocate the same number must renumber before landing. A green check at
  PR open is not proof at merge time: the gate re-validates uniqueness
  against the landing-time main revision (pre-merge re-run or merge
  queue), and a collision found there blocks landing until the branch
  renumbers. Never reuse a removed number or an alias for a different
  product. Allocation and removed-identity discovery require complete
  history — a shallow checkout omits earlier allocations and deletions,
  so the operation fails explicitly on `is-shallow-repository` with a
  `git fetch --unshallow` remediation rather than silently reusing a
  number whose removal it cannot see.
- Native layout is `<KEY-N>-<slug>.md` or
  `<KEY-N>-<slug>/spec.md` under `sdd.dir`. Slug is cosmetic: resolve by
  the exact `KEY-N-` prefix, with frontmatter ID agreement, not a guessed
  slug. Duplicate flat/dir IDs or ambiguous aliases are named errors.
- A child spec has its own number and `parent: KEY-N`. A part has no ID
  or lifecycle of its own: it is a subfile referenced as `BRO-12/cache`.
  Own bead/lifecycle means child spec; splitting text means part. Directory
  placement alone does not turn every Markdown subfile into a child.
- `aliases` retain old bead IDs. `spec bro-xxxx` citations keep resolving
  after consolidation, including when several old records map to one
  product spec. Cross-spec alias collisions fail validation.

### Facade contract — bro-y1jtm.1

`SpecStore` owns tool-neutral contracts only: `resolve(id|alias)` (including
part references), lifecycle-aware `list`, `owns`, `lint`, conformance
inputs and migration-source enumeration, alongside compatible existing
methods during transition. Connectors declare capabilities and implement
what their tool can represent; an absent capability yields an explicit
unsupported/unavailable result and remediation, not a crash or fabricated
passing result. Empty supported results are distinct from unsupported.

Commands and gates consume that contract; they never branch on a concrete
tool name. Native, speckit, openspec and agent remain connectors; other
tools, including superpowers/ADR workflows, can supply connectors without
changing core. Formats, schemas, tool commands and migration readers stay
in the connector layer. Facade-level identity/lifecycle are normalized
views, not a requirement to rewrite an external tool's storage. Capability
gaps are reported in audits so a missing ownership/conformance provider
cannot silently make a strict CI gate green.

### Native schema and template — bro-y1jtm.2

Use zod v4 as the native schema's single source; export JSON Schema through
`z.toJSONSchema` and render the scaffold/template from that schema and
section configuration, not a second handwritten field contract.

Required native frontmatter: `id`, `title`, `status`, `area`,
`owns: [pathspecs]`, `beads: [...]`, `aliases: [legacy bead ids]`.
Optional: `parent`, `superseded-by`. IDs and references are validated;
arrays may be empty where appropriate (e.g. draft with no implementation),
but cannot weaken source coverage. Default required body sections are
Problem / Design / Verify. Required sections and subfile roles (including
decision records) are configurable; project schema extensions can add
validated fields. Unknown unconfigured keys and invalid types fail loud.
Exported schema, generated template, lint and project extensions must agree.

### Lint and CI — bro-y1jtm.3

`bro spec lint` checks frontmatter, configured sections/roles, parent and
supersession validity, live `KEY-N`/part references, aliases and unique
numbers. A historical removed target is reported as removed rather than
silently accepted as a live normative reference. Parent/supersession
cycles and dangling references fail with file/field diagnostics.

`owns` uses repo-relative pathspecs evaluated over the configured source
inventory: every source file must have exactly one owning product spec;
zero owners or overlapping ownership is an error. Tests, generated and
vendored paths are explicitly classified/configured, never silently
dropped. Parts inherit their spec's ownership; parent and child specs
must partition source ownership rather than both claim the same paths.

Against the PR's base/head diff, a behavior change in owned code requires
the owning spec (or the relevant part) to change in the same diff. An
explicit `spec unchanged: <reason>` statement permits a reviewed
refactor/no-behavior fix, not an unreviewed behavioral exception. Include
added, renamed and deleted paths and ownership changes; inspect base and
head owners so a PR cannot evade the gate by deleting/changing `owns`.
The deterministic lint flags untouched specs; semantic review decides
behavior and the validity of exceptions. Mere spec whitespace edits are
not conformance evidence. CI runs lint with explicit base/head and PR
context; report findings distinctly from unsupported capabilities or
missing inputs, and fail a strict audit when required checks are unknown.
Wire this into bro CI during implementation, not in this design-only change.

### Conformance — bro-y1jtm.4

Replace commit-recency drift with computed, evidence-backed conformance:
`conformant | spec-ahead | code-ahead`. A spec-ahead product is permissible
while an open linked change bead explicitly covers the missing behavior;
without that bead it is a defect. Code-ahead is always a defect. If both
directions occur, show both findings; never let an open bead excuse
unspecified shipped behavior. A PR must decide which side is wrong and
fix the other, not automatically prefer code or prose.

Inputs include resolved spec/parts, ownership, diff, linked change beads,
verification results and semantic review evidence tied to revisions.
Checks cannot prove all prose semantics: unavailable/stale evidence is an
explicit unknown assessment, not a fourth product lifecycle value or
`conformant` by default. Timestamps and later commits are not divergence.
Compatibility for `drift`/`check` reports the transition and maps to the
new assessments where supported; it must not retain STALE as the verdict.

### Status, list and show — bro-y1jtm.5

`bro spec status [KEY-N]`, `bro spec list`, and `bro spec show <KEY-N>`
resolve IDs, aliases and parts through the facade. Status/list display
separate axes: stored lifecycle; computed conformance with evidence or
unknown; readiness from linked bead states; reachability (who cites it).
Readiness does not close/remove a spec; zero citations does not archive it.
Provide stable JSON output, explain unavailable connector capabilities and
missing bead backends, and distinguish no links from inaccessible links.
Removed identities remain discoverable from git history without pretending
their deleted files or references are live; where history is incomplete
(shallow checkout) status/list report the discovery as unavailable rather
than silently omitting removed identities.

### Migration — bro-y1jtm.6

`bro spec migrate` consolidates existing material into product specs,
including bro's bead-specs, sverka's `NN-slug/spec.md`, speckit, openspec
and other connector-provided sources. Inventory sources and references;
produce a reviewable dry-run mapping of source → product/part, IDs,
aliases, bead links and ownership. Consolidation is a semantic decision,
not filename renaming: preserve normative requirements and surface
contradictions for review. No automatic loss of unreferenced requirements.

Apply only an approved mapping against the same source revisions, refuse
dirty/conflicting paths, write targets and aliases, update citations where
needed, validate coverage/references, then delete old source files in the
same git change. Re-verify the checked revision immediately before each
delete — a source edited between review and apply aborts that delete for
a fresh review instead of silently discarding the user's newer changes.
Git keeps provenance; no new archive or duplicate live source of truth.
Stage application safely for retry/rollback on failure; never delete
originals before successful target validation. Re-running a completed
migration is a no-op. Native output is available but external tools may
retain their own format when their connector supports the model.

### Review initialization — bro-y1jtm.7

`bro spec init` retains connector detection/config bootstrap and
installs/updates one managed `<!-- BEGIN bro:sdd -->` /
`<!-- END bro:sdd -->` block in the project's REVIEW.md. Preserve all
unmanaged policy; repeated init is idempotent. Missing REVIEW.md is created;
duplicate/unbalanced markers fail with remediation, never overwrite prose.
The write compares the file against the snapshot the managed-block plan
was computed from: REVIEW.md changed between read and write aborts the
update for a fresh pass rather than clobbering unmanaged edits made in
between.
The block enforces the gate now recorded in bro's REVIEW.md: missing spec
touch and either divergence direction are critical, unowned code and
contradictory specs major. Owns-based checks activate when metadata exists;
until then use legacy Owns/scope sections for review, reporting incomplete
coverage rather than pretending the new linter is already implemented.

### Adoption — bro-y1jtm.8 and bro-y1jtm.9

`.8` consolidates bro specs by product area, updates README/skill policy,
preserves legacy citations and enables ownership/conformance gates. This
design is intentionally written in today's bead convention; it migrates
to its own `BRO-N` identity under `.8`, retaining `bro-y1jtm` as an alias.
`.9` adopts the feature in sverka through a later `bro request`, not edits
to that foreign repository here. The epic remains incomplete until bro
and sverka both run the facade with published evidence.

Dependency order: `.1 → .2 → .3 → .4 → .5 → .6`; `.7` needs `.1/.3`;
`.8` needs `.3/.4/.5/.6/.7`; `.9` needs `.8`. These are implementation
beads, not nine new product specs. This change ships only design/review
policy and the bead graph; no code, CI config, migration or foreign request.

## Verify

- Contract tests cover all existing connectors and capability-limited
  connectors: unsupported is graceful but cannot produce false conformance.
- Native schema/template/JSON Schema agree; fixtures cover lifecycle,
  configurable sections/roles/extensions, empty lists, malformed IDs,
  duplicate numbers across branches/main/history, aliases, cosmetic slug
  renames, parent cycles, child vs part references and removed identities.
- Lint fixtures cover full/empty source inventories, uncovered/overlapping
  paths, base/head ownership changes, code additions/renames/deletions,
  valid no-behavior exceptions, bogus exceptions and broken live citations.
- Conformance fixtures cover both divergence directions, open/closed/missing
  beads, missing evidence, harmless later commits and spec-touch-only
  changes. Lifecycle never stores conformance/readiness/reachability.
- Migration fixtures for each source format cover dry-run, consolidation,
  citations/aliases, unchanged source revisions, conflicts, interrupted
  application, safe retry, deletion only after validation and idempotence.
- Init fixtures cover absent REVIEW.md, existing unmanaged prose, one-block
  updates, repeated runs and malformed markers. Review severities match
  the installed gate in both legacy and owns-based repositories.
- Implementation runs the repository's existing `npm run build`,
  `npm run typecheck`, `npm test` plus its documented lint/contract checks;
  focused tests live beside `specs.ts`, `spec-connectors.ts` and spec commands.
- Acceptance evidence from both bro and sverka includes migration mapping,
  live KEY-N specs, preserved legacy references, source ownership lint,
  multi-axis status/list/show and an actual reviewed behavior-changing diff
  that demonstrates the conformance gate. A bro-only rollout is not done.
- This docs-only design is checked with `node scripts/check-docs.ts`,
  `git diff --check` and the repository pre-commit hook before commit.
