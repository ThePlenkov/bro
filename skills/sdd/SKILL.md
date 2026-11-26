---

name: sdd
description: "Use when the repo enables spec-driven development (`sdd` section in bro.config.json) or asks why bro nudges about missing specs. Thin wrapper over `bro spec` — mechanics live in the CLI; this skill carries policy only."
---

# /sdd (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Spec-driven development: a change bead links to the product spec it
changes **before** code. A product spec describes the enduring product;
it is not a bead-sized change record and it does not disappear when a
bead closes. bro carries the rule, so prompts don't have to — the
`sdd` connector's hook probes inject the policy into session-start and
prompt-submit context, and in `gate` mode the stop gate blocks once
while a session's own claim lacks a spec.

## Two spec classes

The spec tree holds every durable project document, in two classes:

- **Product specs** — `*.spec.md` files describing what the system
  _is_. Identity is a KEY-N id (`BRO-1`) declared in frontmatter
  (`id:`, `title:`, `status:`, `template: brotocol/spec@N`, optional
  `parent:`, `owns:`, `aliases:`). Flat spec:
  `<KEY-N>-<slug>.spec.md`; dir spec: `<KEY-N>-<slug>/` whose index is
  `<KEY-N>-<slug>.spec.md`, with other `.md` files inside as _parts_,
  not specs. Lifecycle `draft → active → deprecated → removed`;
  bead closure never archives a spec — `removed` is a product
  decision with provenance in git. One product spec can outlive and be
  changed by many beads; use `aliases` when consolidating legacy
  bead-keyed references.
- **Policy specs** — fixed-path docs (`AGENTS.md`, `REVIEW.md`,
  `CONTRIBUTING.md`) that describe how to think and work here. They
  keep their conventional paths (clients read `AGENTS.md` at the
  root) and carry a managed `bro:sdd` identity region under the
  title — never frontmatter, so every client keeps reading them
  literally:

  ```markdown
  <!-- BEGIN bro:sdd -->
  id: BRO-3
  title: …
  area: policy
  status: active
  core: [BRO-1]
  <!-- END bro:sdd -->
  ```

  A policy spec must **explain** (the project, its core specs, its
  philosophy — the entry points that route an agent into the spec
  tree) and **bind** (rules the review gate can check). `core:` names
  the product specs it routes to; a policy doc naming no core specs
  is incomplete.

A bead carries a `spec:` link to the product spec (or a part) it
changes. The declared link outranks discovered files, and `check`
counts the declaration itself; resolution and conformance are the
audit's job. A spec may retain legacy bead IDs as aliases, but specs
do not name beads as their reverse index — the task store supplies
that lookup. Exempt: `issue_type: chore` or `molecule` and beads
labeled `trivial` or `debt` — SDD measures design mass, not
bookkeeping.

## Requirements and anchors

Product specs list requirements as `## Requirements` items with stable
anchors `R<n>`; beads and other specs cite them as `KEY-N#R<n>`. Product
spec frontmatter declares `owns: [pathspecs]`: every source path must
have exactly one owning spec (tests, generated files, and vendored
paths are classified explicitly). Until `owns` metadata is available,
review the spec's legacy `Owns`/`scope` section, and treat missing
coverage as incomplete rather than covered.

## Commands

| Command                | What it does                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bro spec check [id…]` | Coverage over `in_progress` beads (`--all` adds open): `spec` / `link` / `exempt` / `MISSING`. Exit 1 on any MISSING — CI-able                                                   |
| `bro spec drift [id…]` | Compatibility audit for spec/code conformance (`--all` scans all linked work): `conformant` / `spec-ahead` / `code-ahead`, plus explicit unknown inputs; commit timestamps are not evidence |
| `bro spec new <id>`    | Scaffold a product spec for a change bead — target model renders the `brotocol/spec@N` template with an allocated KEY-N id; `--parent <id>` links the tree                     |
| `bro spec tree`        | The spec hierarchy — roots, children, MISSING for claimed beads with none                                                                                                        |
| `bro spec init`        | Bootstrap SDD: detects `.specify/`/`openspec/` and writes `connectors.specs` + `sdd.mode: remind`; on a bare repo scaffolds a native `specs/` root. `--tool` overrides detection |

Engine status: `check`/`drift`/`tree`/`init` run today over the native
connector (`*.spec.md` + dir specs included); KEY-N allocation in
`new`, lifecycle lint, and policy-doc discovery land with
`@broject/spec` — until then a hand-written `*.spec.md` with
frontmatter `id:` is already a valid spec node.

## Which SDD tool

The `specs` facade resolves the project's own tool — enforcement speaks
its language, never imposes bro's shape:

| Connector          | Detected by                          | A spec is                                        |
| ------------------ | ------------------------------------ | ------------------------------------------------ |
| `native` (default) | `<sdd.dir>/` exists, or nothing else | `<sdd.dir>/<id>.spec.md` or `<id>/` dir spec     |
| `brose`            | `@broject/spec` plugin               | `*.spec.md` docs on the Brotocol spec protocol   |
| `speckit`          | `.specify/`                          | `specs/<NNN>-<slug>/spec.md`, linked via `spec:` |
| `openspec`         | `openspec/`                          | `openspec/changes/<id>/proposal.md`              |
| `agent`            | explicit only                        | no files — `spec:` links are the evidence        |

Override detection: `"connectors": { "specs": "openspec" }`.

## Config

```json
"sdd": { "mode": "gate", "dir": "specs" }
```

| `mode`          | Effect                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | Nothing — the section's absence opts the repo out                                                                                                           |
| `remind`        | Session-start policy line; prompt-submit nudge while an own claim lacks a spec                                                                              |
| `gate`          | All of remind, plus the stop gate blocks once under the `task` aspect (armed by `bd --claim` / `bro work enter`). A repeated stop passes — gates, not loops |

Only **this session's** claims are judged (the `.task` marker, same
scope rule as the parallel-work nudge) — other sessions' un-spec'd
beads are never your blocker.

## Policy

- **Spec first, then code.** Claim → link the product `*.spec.md` (or
  part) that owns the change; edit it when the product contract changes
  → implement. Policy docs only are appropriate when the work changes
  how the repo thinks. A new bead-keyed spec is not a substitute for
  updating the owning product spec.
- Small enough to not need design mass? Label the bead `trivial`
  instead of writing an empty spec file — a stub defeats the audit.
- `bro spec check` is the self-audit; wire it into CI the same way
  `bro review act status` gates PRs.
- `bro spec drift` is a conformance audit, not a commit-recency check.
  `conformant` requires evidence; `spec-ahead` is allowed only with an
  open linked change bead, while `code-ahead` is always a defect. If
  both directions occur, report both and decide which side is wrong.
  Missing or unavailable ownership/evidence is explicit unknown, never
  a passing result.
- Policy docs change rarely and deliberately: editing `AGENTS.md` /
  `REVIEW.md` / `CONTRIBUTING.md` rules is a spec-level act — the
  `bro:sdd` region and the rules it binds are reviewed like any spec.
