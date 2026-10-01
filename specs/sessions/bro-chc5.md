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
  member's squash-merge, `stack sync` rebases children onto the new
  base and retargets open PRs.
- Stacks are metadata: `.git/bro/stacks/<name>` (session-visible,
  worktree-aware like hook markers) + bead dep edges as the durable
  record.
- `bro loop --stack <name>` drives the chain; `bro work enter --onto
  <branch>` is the primitive `stack push` builds on.

## Plan

- [ ] `bro work enter --onto <branch>` — worktree off an arbitrary base
- [ ] `bro stack push/list` — stack registry + members
- [ ] PR base targeting on `gh pr create`
- [ ] `bro stack sync` — post-merge rebase + retarget cascade
- [ ] loop integration + SKILL.md
