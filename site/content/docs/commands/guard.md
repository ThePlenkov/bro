---
title: bro guard
description: Declarative prompt contributions — nudges conditioned on worktree state, session markers, or a judge veto.
---

Guards are one-line nudges the hook evaluates at `session-start`,
`prompt-submit`, `post-tool`, and `stop`. A guard fires when its `when`
clause — event name, match keys, state probes, optional `judge` veto —
holds, and contributes its `say` line to the hook's output. Guards never
block and never grant: a guard line is context, not a gate.

Declarations come from [`guard.defs`](/docs/configuration#guard) in
`bro.config.json` (project-owned) and from connectors' `guards()`
contributions — first name wins, so a config def shadows a builtin.
`guard.enabled: false` silences the mechanism; `guard.maxPerEvent` caps
the lines one event emits; `when.budget` caps how often one guard fires.

| Command | What it does |
| ------- | ------------ |
| `bro guard list [--json]` | Every collected guard: name, source, events, budget, validation state |
| `bro guard test <name> [--event E] [--prompt T] [--session ID]` | Dry-run one guard against live state — per-clause verdicts, then FIRE/SKIP and the rendered line. Read-only: the fired set and verdict journal are untouched |

## The `when` clause

| Key | Match |
| --- | ----- |
| `when.on` | Hook events the guard may fire on |
| `when.state.diff.changed` / `diff.without` | Globs over `git status` (a rename counts both paths) |
| `when.state.branch` | Branch-name glob |
| `when.state.armed` | Session-gate aspects armed this session |
| `when.state.exists` | Repo-relative paths that must exist |
| `when.state.probes` | Engine-registered named probes (`spec-drift`, …) with their own `args` |
| `when.judge` | Ask the [judge](/docs/commands/judge) facade — a veto suppresses the guard; abstention (no judge, low confidence, decide error) doesn't |
| `when.budget` | Fired-set cap — how many times the guard may fire |

One builtin ships — `test-coverage-on-stop` nudges at `stop` when
`src/**` moved and no test file did. Bro's own repo config adds
`retro-on-stop`, `spec-drift`, and vendor-boundary defs as living
examples.
