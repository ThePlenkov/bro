---
title: Plans
description: Structured TOML input — one envelope, per-command schemas.
---

Commands that take structured input share one envelope: a TOML file with
a `kind` that routes to the owning plugin.

```toml
kind = "retrospect"          # routes to the retrospect plugin

[retro]
what = "the deploy broke"    # required — one line
why = "CI ran a different Node than prod"
scope = "project"

[[actions]]
title = "pin the Node version in CI"
sink = "workaround"          # backlog | memory | agentic-documents | …
```

## `bro run <plan.toml>`

1. Parses the TOML document
2. Reads `kind` → finds the plugin by name
3. Validates the payload against the plugin's `planSchema`
4. Executes via the plugin's `runPlan`

Unknown kinds are rejected with the list of known ones; a plugin without
`planSchema`/`runPlan` says so instead of guessing. Validation is
aggregate — every problem in the file is reported at once, not one error
per run.

`bro retrospect schema` prints the commented template for its kind.

## Kinds

### `retrospect`

Retro plans — `[retro]` what/why/scope/wtf/evidence plus `[[actions]]`
fanned out to prevention beads by `sink`.

### `act`

Batch thread verdicts on the open PR — the fix/reject/defer triage as
one plan instead of N `act resolve`/`reply` calls:

```toml
kind = "act"
pr = 66                      # optional — names the PR in defer beads

[[threads]]
thread_id = "PRRT_..."
action = "resolve"           # resolve | reply | defer
comment = "fixed in abc123"  # required for reply; optional elsewhere

[[threads]]
thread_id = "PRRT_..."
action = "defer"             # → debt bead + reply + resolve
title = "the bead's title"   # required for defer
```

`defer` creates a `debt`-labeled bead linked by `--external-ref` to the
thread — if the bead can't be created, the thread is **not** resolved.
A failed verdict doesn't abort the rest; failures are listed at the end.

### `debt`

Batch triage verdicts for the review-debt ledger — replaces N
interactive `bro debt set` calls:

```toml
kind = "debt"

[[verdicts]]
thread_id = "PRRT_..."
status = "wontfix"           # open|claimed|done|wontfix|duplicate
notes = "infra flake, not ours"

[[verdicts]]
thread_id = "PRRT_..."
status = "done"
fix_pr = 58                  # the PR that landed the fix
```

## Why TOML

Diff-friendly, comment-friendly, and forgiving for agents writing it by
hand — a plan is usually drafted in chat, pasted to a file, and run.
