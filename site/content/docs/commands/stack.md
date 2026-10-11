---
title: bro stack + bro work
description: Stacked bead→worktree→PR chains, and the sibling worktrees they ride on.
---

## `bro stack`

A named stack is an ordered bead → worktree → PR chain. Each member starts
from the previous member's branch, so dependent work can review before the
parent lands.

| Command | What it does |
| ------- | ------------ |
| `bro stack push <bead> [--name <stack>]` | Claim a bead and create or re-enter its stack member |
| `bro stack list [<name>]` | Show positions, bases, worktrees, and PR state |
| `bro stack sync [<name>]` | Retarget and rebase child members after a merge — skipped where the platform already did it |
| `bro stack publish [<name>]` | Register the chain's open member PRs as the host's stack object (GitHub: `gh stack link`) |
| `bro stack merge [<name>] [--squash\|--merge\|--rebase] [--admin]` | Land the chain bottom→top, gated member by member |

`--name` is required from the main checkout and inferred inside a stack
member. Sync skips dirty or locked worktrees instead of touching them.
`bro loop --stack <name>` drives the same chain automatically.

`stack merge` and `stack sync` dispatch per connector: GitHub uses the
`gh stack` extension's atomic `gh stack merge` when installed (else a
per-layer fallback) and skips the retarget/rebase the platform already
did on `.stack` PRs; GitLab relies on native stacked-MR retargeting and
merges bottom-up per layer; a repo with no forge merges the chain
locally in the primary worktree. `stack publish` exists only where the
host keeps a stack registry — GitHub's `gh stack link` creates or grows
it (needs ≥2 open member PRs, idempotent on re-run); GitLab and plain
git detect chains from the PR base links themselves, so the command
declines there. A clean `stack sync` publishes automatically, and
`stack list` hints while open member PRs are unregistered.

## `bro work`

Linked worktrees keep parallel sessions from colliding:

| Command | What it does |
| ------- | ------------ |
| `bro work enter <slug> [--branch <name>] [--base <ref>] [--stack]` | Create or enter a sibling checkout |
| `bro work leave [slug] [--force] [--delete-branch]` | Remove a worktree and optionally its branch |
| `bro work list` | List worktrees and clean/dirty state |
| `bro work prune` | Remove administrative entries for deleted worktrees |

`--stack` makes a new worktree base on the current worktree's branch; it
needs a checked-out work branch — from the main checkout's branch, the
default branch, or a detached HEAD it errors. `stack.mode` controls the
default: `manual` (default) requires explicit `--stack` or `--base`;
`auto` uses the current worktree branch when it is not the main
checkout's branch or the repository's default branch — on either it
falls back to the main checkout's branch instead. The edge is recorded
for bottom-up merge order.
