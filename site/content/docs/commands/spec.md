---
title: bro spec — spec-driven development
description: Spec coverage, freshness, hierarchy, and connectors for claimed work.
---

`bro spec` is the spec-driven development facade. With `sdd.mode`
enabled it pushes a claimed bead toward a written spec — `remind` is
advisory (a session-start policy plus a prompt-submit nudge), `gate`
also blocks the stop once under the `task` aspect. The spec rides the
feature branch and stays with the implementation.

## What counts as a spec

With the native connector, a non-empty `<sdd.dir>/<bead-id>.md` counts.
A directory spec also counts when
`<sdd.dir>/<bead-id>/spec.md` or `README.md` is non-empty; nested markdown
files and index-bearing subdirectories form its tree. A `spec:` link in
the bead description is an external spec.

Chores and beads labeled `trivial` or `debt` are exempt. SDD measures
design mass, not bookkeeping, and a harvested review finding already
carries evidence.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro spec check [id…]` | Audit coverage for claimed work; `--all` includes open beads and exits non-zero for `MISSING` |
| `bro spec drift [id…]` | Audit freshness of spec'd beads; `--all` scans all, `--json` emits rows, and `--ref` overrides the comparison ref |
| `bro spec new <id> [--parent <id>]` | Scaffold a spec from the bead title without overwriting |
| `bro spec tree` | Show roots, children, and missing specs |
| `bro spec init [--tool <name>]` | Detect or bootstrap an SDD tool and write the connector/mode configuration |

`check` covers claimed work by default. `drift` compares landed code
scope with the spec and reports `STALE`, `fresh`, `no-scope`, or
`unverifiable`; only stale rows fail that audit.

## Connectors

| Connector | Detected by | Spec shape |
| --------- | ----------- | ---------- |
| `native` | `<sdd.dir>/` exists, or no other tool matches | `<sdd.dir>/<id>.md` or a directory spec |
| `speckit` | `.specify/` | `specs/<NNN>-<slug>/spec.md`, linked with `spec:` |
| `openspec` | `openspec/` | `openspec/changes/<id>/proposal.md` or `openspec/specs/<id>/spec.md` |
| `agent` | Explicit selection only | No files; `spec:` links are the evidence |

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
