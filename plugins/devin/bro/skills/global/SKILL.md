---
name: global
description: "Use when a task or bead is user-level rather than project work — global beads live in a separate store under the user's home, queried only on explicit request. Thin wrapper over `bro global` — mechanics live in the CLI."
---

# /global (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro global` keeps user-level beads in their own store — a plain `bd init`
directory, local-only by default. Project queues and the global queue are
different databases: nothing global can leak into `bro next`, `bro loop`,
or session rehydrate output. Global work is opt-in at every call.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro global init [--prefix P]` | Create + validate the store (default `~/.local/share/bro/beads`) |
| `bro global path` | Print the resolved store dir |
| `bro global <bd args…>` | Run `bd` against the store — `bro global ready`, `bro global create …` |
| `bro next --global` | Schedule from the global queue — the same next pipeline, cwd = the store |

## Store location

Resolution order — first hit wins:

1. `BRO_GLOBAL_BEADS` env var
2. `beads.global` in `bro.config.json`
3. `~/.local/share/bro/beads`

The store is a `bd init` dir, not a repo — no sync remote is configured.
For a cross-machine queue, set the store's own Dolt remote inside it
(`bd dolt remote` in the store dir) — bro does not manage it.

## Policy

- **Project work goes to project beads.** `bro next`, `bro loop`, hooks —
  all read the checkout's `.beads` only. Global beads are claimed only
  through `bro next --global` or `bro global <sub>`.
- **Global is for user-level work** — cross-repo tasks, personal backlog,
  anything that must not ride the project's issue tracker or land in its
  PRs. If in doubt, file in the project.
- **Explicit, always.** Never run `bro global` passthrough as part of
  project automation; the two stores are scoped on purpose.
