---
name: stack
description: "Use when work should land as a stacked bead→worktree→PR chain (gh-stack analogue) — `bro stack push` a bead onto a named stack, `bro stack list` the chain, `bro stack sync` after a member merges, `bro loop --stack` to drive it. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /stack (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

A stack is an ordered chain of beads: member N's worktree branches off
member N-1's branch and its PR targets that branch, so dependent work
reviews while the parent is still in flight. The stack is a *view* over
`stack/<name>/<n>-<slug>` branches plus the `.git/bro/stack/` edges
`bro work enter` records — dead branches just drop out.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro stack push <bead> [--name <stack>]` | Sibling worktree `<repo>--<bead>` on branch `stack/<name>/<n>-<bead>`, based on the stack tip (first member bases on the main checkout's branch). Name comes from `--name` or the current `stack/<name>/…` worktree. Claims the bead, like `work enter` |
| `bro stack list [<name>]` | The chain: position, bead, branch, recorded base, worktree state, PR state + declared base |
| `bro stack sync [<name>]` | Post-merge cascade: retarget open child PRs to the new base and rebase child branches; a dirty or locked worktree is skipped and reported — its owner rebases on enter |
| `bro loop --stack <name>` | The autonomous runner chains every claimed bead onto the named stack and syncs after each landed merge |

## Policy

- **Push beads, not branches.** `stack push` names the bead — the
  branch/worktree/PR machinery follows; a beadless slug still works but
  claims nothing.
- **Open member PRs against the member below** — `gh pr create --base
  stack/<name>/<n-1>-…`, never the default branch. `stack push` prints
  the exact command.
- **Merge bottom-up, then `stack sync`.** A squash-merged member leaves
  the chain; sync retargets the next open PR and rebases its branch.
  Sync is safe to rerun — in-sync members are no-ops.
- **Never sync over someone's dirty worktree.** Skipped members keep
  their recorded base; the owner rebases when they re-enter.
- Stacks compose with `bro work enter --stack` — the same edge registry
  backs both (`stack.mode: "auto"` ad-hoc chains vs named `bro stack`
  chains).
