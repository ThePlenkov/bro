---
name: stack
description: "Use when work should land as a stacked bead→worktree→PR chain (gh-stack analogue) — `bro stack push` a bead onto a named stack, `bro stack list` the chain, `bro stack sync` after a member merges, `bro stack merge` to land it, `bro loop --stack` to drive it. Thin wrapper over the bro CLI — mechanics live in the CLI."
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
| `bro stack push <bead> [--name <stack>]` | Sibling worktree `<repo>--<bead>` on branch `stack/<name>/<n>-<bead>`, based on the stack tip (first member bases on the default branch). `--name` is required from the main checkout; inside a `stack/<name>/…` member worktree the name is inferred. Re-pushing a bead that is already a member re-enters its worktree — no duplicate position. Claims the bead, like `work enter` |
| `bro stack list [<name>]` | The chain: position, bead, branch, recorded base, worktree state, PR state + declared base |
| `bro stack sync [<name>]` | Post-merge cascade: retarget open child PRs to the new base and rebase child branches — skipped where the platform already did it; a dirty or locked worktree is skipped and reported — its owner rebases on enter |
| `bro stack merge [<name>] [--squash\|--merge\|--rebase] [--admin]` | Land the chain bottom→top through the connector's own mechanism after gating every mergeable member's act gate; post-merge sync runs automatically |
| `bro loop --stack <name>` | The autonomous runner chains every claimed bead onto the named stack and syncs after each landed merge |

## Connector dispatch

Stack ops are the connector's answer to "what does the platform already
do" — `bro stack` never hand-rolls a step the host owns:

- **GitHub** — a `.stack`-marked PR means the platform retargets
  dependents AND rebases their remote branches on merge: sync skips the
  API retarget and fast-follows the remote (local-only commits replay
  on top — never a force-push over the platform's rewrite). With the
  `gh stack` extension installed, `stack merge` is one atomic
  `gh stack merge <top-pr> --yes`; without it, per-layer merge-async.
- **GitLab** (19.1+) — the platform detects the chain from target
  branches and retargets the next MR on each merge; bro never calls the
  retarget API there. Merge is bottom-up `PUT …/merge` per layer —
  that IS the platform flow.
- **plain git** — no forge: `stack merge` lands each member into the
  trunk inside the primary worktree, sync is a local rebase cascade.

## Policy

- **Push beads, not branches.** `stack push` names the bead — the
  branch/worktree/PR machinery follows; a beadless slug still works but
  claims nothing.
- **Open member PRs against the member below** — the push hint is the
  connector's (`gh pr create --base`, `glab mr create
  --target-branch`); the bottom member targets the default branch. A
  forge-less repo prints no hint — there is nothing to open.
- **Merge via `stack merge`, then it syncs itself.** The merge set is
  the contiguous prefix of live members with an OPEN PR — a PR-less
  member breaks the chain and merge stops below it. Every member's act
  gate must be green before the first merge call. A squash-merged
  member leaves the chain — its edge is retired and its branch is
  deleted once no worktree holds it.
- **Sync is safe to rerun** — in-sync members are no-ops, and
  platform-owned cascade steps are skipped rather than duplicated.
- **Never sync over someone's dirty worktree.** Skipped members keep
  their recorded base; the owner rebases when they re-enter.
- Stacks compose with `bro work enter --stack` — the same edge registry
  backs both (`stack.mode: "auto"` ad-hoc chains vs named `bro stack`
  chains).
