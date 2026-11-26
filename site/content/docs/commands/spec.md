---

title: bro spec — spec-driven development
description: Spec coverage, freshness, hierarchy, and connectors for claimed work.
---

`bro spec` is the spec-driven development facade. With `sdd.mode`
enabled it pushes a claimed change toward its product spec — `remind`
is advisory (a session-start policy plus a prompt-submit nudge), `gate`
also blocks the stop once under the `task` aspect. Product specs
describe the enduring product, ride the feature branch when their
contract changes, and persist after the linked bead closes.

## What counts as a spec

With the native connector, a non-empty product spec counts. The
preferred layout is `<sdd.dir>/<KEY-N>-<slug>.md` or
`<KEY-N>-<slug>/spec.md`; `*.spec.md` remains the spec marker for
compatible trees and `bro spec new` scaffolds a node. A directory spec
counts when its index is non-empty (`spec.md` and `README.md` remain
accepted legacy indexes); nested specs and index-bearing
subdirectories form its tree, while plain `.md` files in an unindexed
directory are content, not specs. A `spec:` link in the bead description
identifies the product spec or part that owns the change. Legacy
bead-keyed files may be resolved during migration, but are not the
product identity.

When a bead has both a `spec:` link and a discovered spec file, the
declared link wins: `check` reports `link` and the audit resolves that
product spec. The bead's own statement outranks convention-based
discovery. Coverage reads the working tree, so an uncommitted spec file
already counts for `check`; conformance is about behavior and ownership,
not whether a later commit has a newer timestamp.

Chores, molecule ship-beads, and beads labeled `trivial` or `debt` are
exempt. SDD measures design mass, not bookkeeping, and a harvested
review finding already carries evidence.

## Commands

| Command                             | What it does                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bro spec check [id…]`              | Audit coverage for claimed work; `--all` includes open beads and exits non-zero for `MISSING`                     |
| `bro spec drift [id…]`              | Audit spec/code conformance; `--all` scans all, `--json` emits rows, and `--ref` overrides the comparison ref     |
| `bro spec new <id> [--parent <id>]` | Scaffold a spec from the bead title without overwriting                                                           |
| `bro spec tree`                     | Show roots, children, and missing specs                                                                           |
| `bro spec init [--tool <name>]`     | Detect or bootstrap an SDD tool and write the connector/mode configuration                                        |

`check` covers claimed work by default. The conformance audit compares
the behavior of owned code with the product contract and reports
`conformant`, `spec-ahead`, or `code-ahead`, with missing or unavailable
evidence explicit as unknown. `spec-ahead` is permitted only when an
open linked change bead covers the missing behavior; `code-ahead` is
always a defect. Timestamps, a spec-only touch, or unrelated prose
edits are not conformance evidence.

## Ownership and conformance

Product spec frontmatter uses `owns: [pathspecs]`. Every source path has
exactly one owning product spec; tests, generated output, and vendored
paths are classified explicitly. A behavior change in owned code must
change that spec (or its relevant part) in the same diff. A reviewed
`spec unchanged: <reason>` statement is valid only for a refactor or
other no-behavior fix. Until `owns` metadata is available, use the
spec's legacy `Owns`/`scope` section and report incomplete coverage
instead of treating missing ownership as proof of conformance.

Specs persist through bead closure. Removal is a product lifecycle
decision (`removed`) with provenance in git; closing a change does not
archive its product spec.

## Connectors

| Connector  | Detected by                                   | Spec shape                                                           |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `native`   | `<sdd.dir>/` exists, or no other tool matches | `<sdd.dir>/<id>.spec.md` or a directory spec                         |
| `speckit`  | `.specify/`                                   | `specs/<NNN>-<slug>/spec.md`, linked with `spec:`                    |
| `openspec` | `openspec/`                                   | `openspec/changes/<id>/proposal.md` or `openspec/specs/<id>/spec.md` |
| `agent`    | Explicit selection only                       | No files; `spec:` links are the evidence                             |

Detection can be overridden with
`"connectors": { "specs": "openspec" }`.

## Modes and the gate

The `sdd` section has two keys:

```json
{ "sdd": { "mode": "remind", "dir": "specs" } }
```

`mode` is `off` (the default), `remind`, or `gate`. `dir` defaults to
`specs`. `off` emits nothing; `remind` adds session-start policy and a
prompt-submit nudge while this session's claim lacks a spec; `gate` also
blocks once under the `task` aspect. The stop gate is armed by
`bd --claim` or `bro work enter`, and only this session's claims count.
A repeated stop passes: gates, not loops.
