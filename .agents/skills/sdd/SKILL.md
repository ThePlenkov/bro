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

## What counts as a spec

- `<sdd.dir>/<bead-id>.md` in the repo — non-empty (`specs/` by
  default; the configured dir applies). The file rides the feature
  branch, so the spec is reviewed in the same PR as the code.
- or a **dir spec**: `<sdd.dir>/<bead-id>/` whose non-empty `spec.md`
  (or `README.md`) is the index — a spec that is a folder of files. Nested
  `.md` files and index-bearing subdirs are its children; nesting IS
  the spec tree (a `.md` inside a dir with no index is content, not a
  spec).
- or a `spec:` link in the bead description (external doc).

Exempt: `issue_type: chore` or `molecule` (ship-beads are convoy
scaffolding, not design work) and beads labeled `trivial` or `debt` —
SDD measures design mass, not bookkeeping, and a harvested review
finding already carries its own evidence.

## What a spec is — and is not

A bead is intent-to-change: it opens, gets claimed, closes. A spec is a
stable project artifact — it rides the feature branch, is reviewed with
the code, and stays on main as what the project now *is*. Specs form a
tree: an epic's spec-of-specs decomposes into feature specs — children
sit inside the parent's dir spec, or a flat spec points at its parent
via `parent:` frontmatter (`bro spec new <id> --parent <epic>` writes
inside `<sdd.dir>/<epic>/` when the parent is a dir spec).

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro spec check [id…]` | Coverage over `in_progress` beads (`--all` adds open): `spec` / `link` / `exempt` / `MISSING`. Exit 1 on any MISSING — CI-able |
| `bro spec drift [id…]` | Freshness over spec'd **closed** beads (`--all` scans every spec'd bead): `STALE` / `fresh` / `no-scope` / `unverifiable`, from spec-vs-scope commit recency on `origin/HEAD` (fallback: local `main`/`master`, remote-tracking `origin/main`/`master`, then `HEAD`; `--ref` overrides). Exit 1 on any STALE |
| `bro spec new <id>` | Scaffold `<sdd.dir>/<id>.md` from the bead title; never overwrites. `--parent <id>` links the tree |
| `bro spec tree` | The spec hierarchy — roots, children, MISSING for claimed beads with none |
| `bro spec init` | Bootstrap SDD: detects `.specify/`/`openspec/` and writes `connectors.specs` + `sdd.mode: remind`; on a bare repo scaffolds a native `specs/` root. `--tool` overrides detection |

## Which SDD tool

The `specs` facade resolves the project's own tool — enforcement speaks
its language, never imposes bro's shape:

| Connector | Detected by | A spec is |
| --------- | ----------- | --------- |
| `native` (default) | `<sdd.dir>/` exists, or nothing else | `<sdd.dir>/<id>.md` or `<id>/` dir spec |
| `speckit` | `.specify/` | `specs/<NNN>-<slug>/spec.md`, linked via `spec:` |
| `openspec` | `openspec/` | `openspec/changes/<id>/proposal.md` |
| `agent` | explicit only | no files — `spec:` links are the evidence |

Override detection: `"connectors": { "specs": "openspec" }`.

## Config

```json
"sdd": { "mode": "gate", "dir": "specs" }
```

| `mode` | Effect |
| ------ | ------ |
| `off` (default) | Nothing — the section's absence opts the repo out |
| `remind` | Session-start policy line; prompt-submit nudge while an own claim lacks a spec |
| `gate` | All of remind, plus the stop gate blocks once under the `task` aspect (armed by `bd --claim` / `bro work enter`). A repeated stop passes — gates, not loops |

Only **this session's** claims are judged (the `.task` marker, same
scope rule as the parallel-work nudge) — other sessions' un-spec'd
beads are never your blocker.

## Policy

- **Spec first, then code.** Claim → `bro spec new <id>` → fill
  Problem/Design/Plan → implement. The spec lands in the same PR.
- Small enough to not need design mass? Label the bead `trivial`
  instead of writing an empty spec file — a stub defeats the audit.
- `bro spec check` is the self-audit; wire it into CI the same way
  `bro act status` gates PRs.
- `bro spec drift` audits **shipped** specs — a spec the code moved
  past is debt to reschedule, not a gate. `unverifiable`/`no-scope`
  rows report coverage gaps and never fail the run.
