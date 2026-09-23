---
name: work
description: "Use when starting work in a shared repo, when parallel agent sessions fight over one checkout, or to clean up git worktrees. Thin wrapper over `bro work` — mechanics live in the CLI."
---

# /work (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro work` keeps parallel work parallel-friendly: one linked git worktree
per task, never the shared primary checkout. Git refuses to check out the
same branch in two worktrees — that refusal is the collision fence.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro work enter <slug>` | Sibling checkout `<repo>--<slug>` on branch `work/<slug>` (`--branch`, `--base` override); an existing branch is checked out, not recreated. Tries to init submodules and, if `<slug>` names a bead, to claim it — both best-effort |
| `bro work leave [slug]` | Remove the worktree — the current one by default; `--force` discards dirty state, `--delete-branch` drops a merged branch. Submodule trees are force-removed without touching the shared submodule config |
| `bro work list` | Every worktree: branch, clean/dirty count, `--sizes` adds `du` |
| `bro work prune` | Drop admin entries for worktrees already deleted on disk |

## Policy

- **Default to a worktree for any task that edits files.** The primary
  checkout is shared infrastructure — treat it as read-mostly.
- **Leave clean.** A session that created a worktree removes it before
  stopping; the stop hook blocks once while the current worktree is dirty.
- **Worktrees are siblings**, never nested — `<repo>--<slug>` next to the
  checkout. Nothing to gitignore; wiping one never strands another.
- Gitignored dirs (`node_modules`, `dist/`) don't follow — run the repo's
  install step inside the new worktree.
- Beads needs no setup: `bd` discovers the shared database through the
  git common dir in any worktree.
- **Slug after the bead.** `bro work enter bro-123` tries to claim bead
  `bro-123` on the way in — a non-bead slug just skips claiming.
