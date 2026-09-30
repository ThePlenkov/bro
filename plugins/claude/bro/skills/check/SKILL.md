---
name: check
description: "Use when the repo has a sverka workflow (sverka.config.ts) or the user asks to run checks/scans through bro. Thin wrapper over `bro check` — mechanics live in the CLI; this skill carries policy only."
---

# /check (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro check` is bro's check facade: **sverka is the executor** — it loads
`sverka.config.ts`, binds an Entry into a Run Plan (plan-time evaluation
can materialize artifacts like gqlb-built queries), runs steps with
parallelism, and returns per-step stats plus optional SARIF findings.
bro parses `sverka run --format json` and renders the report — step
status/duration lines, totals, findings + verdict when evaluated.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro check` | Run the repo's sverka workflow (default entry, text report). Exit code mirrors sverka — CI-able |
| `bro check --json` | Structured output: `{command:"check", data:{planId,status,steps[],findings?,verdict?}, durationMs}` |
| `bro check --evaluate` | Also collect `*.sarif` artifacts and run sverka's policy gate (verdict→exit code) |
| `bro check --root <dir>` | Run against another checkout — its bro.config and node_modules apply |

`--config`, `--entry`, `--executor host|docker`, `-q`, `-v` pass through
to `sverka run`.

## Config

```json
{
  "check": {
    "bin": "sverka",
    "config": "sverka.config.ts",
    "entry": "default",
    "executor": "host",
    "evaluate": false
  }
}
```

All fields optional: `bin` skips binary resolution entirely; `config`,
`entry`, `executor` map to the same-named `sverka run` flags;
`evaluate: true` turns on SARIF collection + the policy gate.

Flags win over config. Binary resolution: `check.bin` → the repo's
pinned install (`node_modules/@sverka/cli` then `.bin` shims, walking
up from root) → `sverka` on PATH → the `@sverka/cli` bundled with
`@broject/bro`.

## Policy

- **Prefer `bro check` over a bare `sverka run`** in repos wired for bro —
  same execution, bro-shaped output, and the exit code already mirrors
  the gate (nonzero on step failure or failing policy verdict).
- `evaluate: true` only for configs whose steps declare SARIF artifact
  outputs — otherwise sverka has nothing to collect (bro retries without
  it once and warns; fix the config, don't rely on the retry).
- Findings→beads dedup is not wired yet — `bro check` reports findings;
  it does not file them.
