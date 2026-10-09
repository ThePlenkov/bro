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
| `bro work enter <slug>` | Sibling checkout `<repo>--<slug>` on branch `work/<slug>` (`--branch`, `--base` override). Base is explicit: the main checkout's branch by default — `--stack` (or `stack.mode: "auto"` in bro.config.json) bases on the current worktree's branch instead, and the edge is recorded under `.git/bro/stack/` for bottom-up merge order. An existing branch is checked out, not recreated. Tries to init submodules and, if `<slug>` names a bead, to claim it — both best-effort |
| `bro work leave [slug]` | Remove the worktree — the current one by default; `--force` discards dirty state, `--delete-branch` drops a merged branch. Submodule trees are force-removed without touching the shared submodule config |
| `bro work list` | Every worktree: branch, clean/dirty count, `--sizes` adds `du` |
| `bro work prune` | Drop admin entries for worktrees already deleted on disk. `--loop` also reaps `loop/*` (and `stack/*`) litter: worktrees whose bead is closed or whose PR merged get removed with their branch — but only when verifiably clean, unclaimed, unlocked, and unoccupied. Dirty trees, open PRs, live agents, and unverifiable beads are kept with the reason named. `--dry-run` reports verdicts without touching anything |

## Policy

- **Default to a worktree for any task that edits files.** The primary
  checkout is shared infrastructure — treat it as read-mostly.
- **Leave clean.** A session that created a worktree removes it before
  stopping; the stop hook blocks once while the current worktree is dirty.
- **Worktrees are siblings**, never nested — `<repo>--<slug>` next to the
  checkout. Nothing to gitignore; wiping one never strands another.
- Gitignored dirs (`node_modules`, `dist/`) don't follow — run the repo's
  install step inside the new worktree.
- **Shared repos fence non-fast-forward branch moves.** bro's
  `reference-transaction` hook vetoes `reset`/`fetch`/`update-ref`-style
  rewrites of `refs/heads/*`; content moves (commit, merge, rebase,
  pull) always pass. A deliberate rewrite needs `BRO_REF_GUARD=off`.
- Beads needs no setup: `bd` discovers the shared database through the
  git common dir in any worktree.
- **Slug after the bead.** `bro work enter bro-123` tries to claim bead
  `bro-123` on the way in — a non-bead slug just skips claiming.
- **Stacked PRs**: with `stack.mode: "auto"`, a second `bro work enter`
  run from inside a worktree bases the new branch on that worktree's
  branch — the session's stack head. `manual` (default) needs `--stack`
  or `--base`. Merge a stack bottom-up; gh-stack drives submit/sync.
