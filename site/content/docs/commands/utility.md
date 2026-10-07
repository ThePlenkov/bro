---
title: Utility commands
description: setup, diagnostics, checks, plans, sync, cleanup, and stores.
---

| Command | What it does |
| ------- | ------------ |
| `bro setup [--beads] [--skills] [--pack [NAME]]` | Wire bro into the repo and optionally initialize beads, skill wrappers, and a capability pack; also installs the commit-provenance git hook |
| `bro hooks install` / `bro hooks uninstall` | Install/remove the `prepare-commit-msg` hook that appends `Agent`/`Agent-Model`/`Session`/`Bead`/`Molecule` trailers to machine-made commits (a pre-existing hook is chained, never clobbered) |
| `bro doctor [--json]` | Inspect the local bro setup and report diagnostics |
| `bro run <plan.toml>` | Execute a validated [plan](/docs/plans) |
| `bro plan` / `bro plan validate <file>` | List plan kinds or validate a plan without executing it |
| `bro sync [--pull]` | Push or restore bro artifacts on `refs/bro/data` |
| `bro cleanup [--remote] [--dry-run]` | Delete local branches whose PR merged |
| `bro plugins` | Print the live plugin registry |
| `bro plugins list [--json]` | Client × scope install matrix |
| `bro plugins install <client> [--global\|--local] [--dry-run]` | Install a client adapter — see [Plugins](/docs/plugins) |
| `bro plugins uninstall <client> [--global\|--local] [--dry-run] [--force]` | Remove a client adapter |
| `bro wtf <complaint>` | Capture a complaint verbatim; see [retrospect](/docs/commands/retrospect) |

`bro next`, `bro loop`, `bro stack`, and `bro work` live in
[bro next](/docs/commands/next), [bro loop](/docs/commands/loop), and
[bro stack + work](/docs/commands/stack). Fleet supervision lives in
[Fleet & supervision](/docs/commands/fleet); the board and the loopback
facade in [status + serve](/docs/commands/status); the mailbox and the
broker in [Events](/docs/commands/events); the bead outflow in
[bro sweep](/docs/commands/sweep).

## `bro check`

`bro check` delegates execution to Sverka. It discovers the repository's
Sverka workflow, prints per-step stats and findings, and mirrors Sverka's
exit code so it can run in CI.

| Command | What it does |
| ------- | ------------ |
| `bro check` | Run the default Sverka entry |
| `bro check --evaluate` | Collect SARIF artifacts and run Sverka's policy gate |
| `bro check --json` | Emit the structured check result |
| `bro check --root <dir>` | Run against another checkout |

Sverka pass-through options include `--config`, `--entry`,
`--executor host|docker`, `-q`, and `-v`. `evaluate` is opt-in and only
belongs on workflows that declare the SARIF artifacts they collect.

## Document verbs and stores

The docs skill keeps beads verbs predictable:

```text
bro task list|show|new|set|close|exec
bro list
bro show <id>
bro close <id>
bro store list|show|init|path
```

`bro task new` accepts a title, `bro task set` updates a status, and
`bro task exec -- <bd args>` passes through to beads. `--global` selects
the user-level store for commands that support it; project and global
stores never mix. For example:

```text
bro store show --global
bro store init --global [--prefix=P]
bro store path --global
```
