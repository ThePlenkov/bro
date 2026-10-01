# bro-chc5 — bro stack: stacked bead → worktree → PR chains

## Problem

Beads already chain by `blocks` deps, but the execution plane doesn't:
every `bro work enter` branches off main, every PR targets main. Work
that genuinely builds on an unmerged sibling either waits for the merge
(serial, slow) or hand-manages rebases (drift, conflict storms). Users
of gh-stack/graphite know the shape: a stack of branches where each PR
targets its predecessor.

## Design

`bro stack` — a stack is an ordered chain of beads; each member gets a
worktree based on the previous member's branch and a PR targeting it.

```text
bro stack push <bead>     → worktree stack/<name>/<n>-<slug>, base = tip
bro stack list [<name>]   → the chain: bead, branch, PR, state
bro stack sync [<name>]   → retarget/rebase after a member merges
```

- First member bases on `main`; member N bases on member N-1's branch.
- `gh pr create --base <prev-branch>`; merge order bottom-up — on a
  member's squash-merge, `stack sync` retargets open child PRs and
  rebases child branches. A dirty or locked child worktree is never
  touched: sync skips it and reports, the owner rebases on `enter`.
- Stacks reuse `bro work enter --base <ref>` (the existing arbitrary-
  base primitive — no new flag) and the existing `.git/bro/stack/`
  edge registry; a named stack is a view over edges + bead deps, not a
  parallel registry.
- `stack push` is ordered failure-safe: worktree first, then branch,
  then registry edge — a failed step leaves no half-member (registry
  write is last, and `stack list` reconciles edges against live
  worktrees/branches).
- `bro loop --stack <name>` drives the chain.

## Plan

- [ ] reuse `bro work enter --base <ref>` — `stack push` passes the stack tip
- [ ] `bro stack push/list` — stack registry + members
- [ ] PR base targeting on `gh pr create`
- [ ] `bro stack sync` — post-merge rebase + retarget cascade
- [ ] loop integration + SKILL.md
