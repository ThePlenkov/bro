---

name: sdd
description: "Use when the repo enables spec-driven development (`sdd` section in bro.config.json) or asks why bro nudges about missing specs. Thin wrapper over `bro spec` — mechanics live in the CLI; this skill carries policy only."
---

# /sdd (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Spec-driven development: a claimed bead gets a written spec **before**
code. bro carries the rule, so prompts don't have to — the `sdd`
connector's hook probes inject the policy into session-start and
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
  decision with provenance in git.
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

A bead may also carry a `spec:` link to any document — the declared
link outranks discovered files, and `check` counts the declaration
itself (resolution is `drift`'s audit). Exempt: `issue_type: chore`
or `molecule` and beads labeled `trivial` or `debt` — SDD measures
design mass, not bookkeeping.

## Requirements and anchors

Product specs list requirements as `## Requirements` items with stable
anchors `R<n>`; beads and other specs cite them as `KEY-N#R<n>` — the
link between the spec tree and the bead graph. Cross-references are
one-directional: beads cite specs, specs never name beads (beads are
swept; specs persist). The reverse lookup — which beads cite a spec —
is derived from the task store, never stored in the spec.

## Commands

| Command                | What it does                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bro spec check [id…]` | Coverage over `in_progress` beads (`--all` adds open): `spec` / `link` / `exempt` / `MISSING`. Exit 1 on any MISSING — CI-able                                                   |
| `bro spec drift [id…]` | Freshness over spec'd **closed** beads (`--all` scans every spec'd bead): `STALE` / `fresh` / `no-scope` / `unverifiable`, spec-vs-scope commit recency. Exit 1 on any STALE     |
| `bro spec new <id>`    | Scaffold a spec for the bead — target model renders the `brotocol/spec@N` template with an allocated KEY-N id; `--parent <id>` links the tree                                    |
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

- **Spec first, then code.** Claim → spec (product `*.spec.md` for the
  change; policy docs only when the work changes how the repo thinks)
  → implement. The spec lands in the same PR.
- Small enough to not need design mass? Label the bead `trivial`
  instead of writing an empty spec file — a stub defeats the audit.
- `bro spec check` is the self-audit; wire it into CI the same way
  `bro review act status` gates PRs.
- `bro spec drift` audits **shipped** specs — a spec the code moved
  past is debt to reschedule, not a gate. `unverifiable`/`no-scope`
  rows report coverage gaps and never fail the run.
- Policy docs change rarely and deliberately: editing `AGENTS.md` /
  `REVIEW.md` / `CONTRIBUTING.md` rules is a spec-level act — the
  `bro:sdd` region and the rules it binds are reviewed like any spec.
