---
name: guard
description: "Use when a declarative prompt contribution should fire on a hook event — a nudge conditioned on worktree state, session markers, or a judge verdict. Thin wrapper over the bro CLI: `bro guard list` inspects what's armed, `bro guard test` dry-runs a def against live state. Requires `bro` (npx -y @broject/bro@0)."
---

# /guard (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only —
collection, matching, probe evaluation, the fired-set budget, and the
judge veto live in `@broject/guard` and the hooks layer.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

Guards are declarative one-line nudges the mega-hook evaluates at
`session-start`, `prompt-submit`, `post-tool`, and `stop`. A guard
fires when its `when` clause — event name, match keys, state probes,
optional `judge` veto — holds, and contributes its `say` line to the
hook's output. They never block and never grant: a guard line is
context, not a gate.

Declarations come from `guard.defs` in `bro.config.json` (first,
project-owned) and from connectors' `guards()` contributions (registry
order, first name wins — a config def shadows a builtin by reusing its
name). `guard.enabled: false` silences the whole mechanism;
`guard.maxPerEvent` caps the lines one event emits.

| Command | What it does |
| ------- | ------------ |
| `bro guard list [--json]` | Every collected guard: name, source (config/connector/skipped), events, budget, validation state |
| `bro guard test <name> [--event <e>]` | Evaluates one guard against live state — prints FIRE/SKIP plus a per-clause verdict row (match, state probe, judge, budget). Writes nothing: the fired set is untouched |

`when.state` keys: `diff.changed`/`diff.without` globs over
`git status` (porcelain `-z -uall`, rename counts both paths),
`branch` glob, `armed` session-gate aspects, `exists` repo-relative
paths, `probes` engine-registered named probes (`spec-drift`, …) with
their own `args`. `when.judge` asks the judge facade — a veto
suppresses; abstention (no judge, low confidence, decide error)
doesn't.

## Policy

- **A guard nudges; it never gates.** `say` is one line of context
  injected into the transcript. Anything that must actually stop work
  belongs in a stop-gate contribution, not a guard.
- **Budget 1 is the default for a reason.** Once a session has seen a
  nudge, the fired set (`<git-common>/bro/hooks/fired/<session>`,
  learn's lock) suppresses repeats — raise `when.budget` only when
  repetition itself is the point, or guard spam becomes the failure.
- **Probes must be cheap.** State probes run inside a hook with a
  host-imposed timeout — argv-git and file stats only. A probe that
  needs the network or a long scan reads cached state or doesn't ship.
- **`when.judge` is a veto, not a driver.** The judge only suppresses
  — it cannot make a guard fire that its deterministic clauses failed.
  Abstention is `ok:true` because an unverifiable condition must not
  silently suppress a nudge either.
- **Test before you ship.** `bro guard test <name>` shows every
  clause's verdict against real state — a guard whose clause can never
  hold is dead weight with a maintenance cost.
- **Renames are loud, not silent.** Two defs sharing a name warn at
  collect time and the first wins — a connector's builtin renamed to
  shadow is intentional; a typo'd name is an unknown-probe clause
  failure visible in `guard test`.
