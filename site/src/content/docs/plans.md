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

## Why TOML

Diff-friendly, comment-friendly, and forgiving for agents writing it by
hand — a plan is usually drafted in chat, pasted to a file, and run.
