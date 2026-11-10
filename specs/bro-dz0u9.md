# bro-dz0u9 — a member's rebase must refuse a history with merge commits

## Problem

`bro stack sync` moves a chain member onto its new base with a plain
`git rebase --onto <base> <fork>`
(`packages/cli/src/commands/stack.ts`, `rebaseMember`). A plain rebase
**linearizes**: the merge commits in the replayed range are dropped, and
with them the conflict resolutions they carry. The member's branch comes
out rewritten, the sync reports `rebased onto <base>` — and the content
the merge commit resolved is gone.

This is the same corruption class `bro stack merge --rebase` already
refuses (PR #872, `packages/core/src/stacks.ts`): there, the member's
range is counted for merge commits and the run stops with

```text
contains merge commits — rebase mergeChain cannot preserve merge resolutions; use merge or squash
```

The stack **sync** path never got the same guard. It is the same
history, the same rewrite, the same loss — only the wording differs.

## Design

### Count the merge commits before the rewrite, refuse the member

The range that a rebase would replay is `<fork>..<head>`: the fork is
where the member's own work starts (the plan's SHA, the base's reflog,
or the member's own creation point), the head is the branch's tip. If
that range holds a merge commit, the replay drops it.

`countMergesInRange(path, range)` — the counter PR #872 wrote — is
exported from `@broject/core` and used here, so both paths answer the
same question with the same code.

Two refusals, two words:

- **the count cannot be read** (`undefined`): git itself failed — a bad
  range, a repo error. The member is skipped: an unknown truth is not
  "no merges", and the rewrite happens anyway.
- **the count is nonzero**: the member is skipped with the #872 wording.
  The owner merges or squashes instead — a member that is skipped is
  visible; a member whose merge resolutions vanished is not.

The branch tip is **pinned** before the count: `m.branch` is a moving
ref, and the count, the range and the rebase must all speak about the
same commits. The tip is read once and used for the range.

### The refusal is a skip, not a crash

`rebaseMember` returns false, the cascade step fails, the member is
reported and the chain's remaining members continue — the same shape as
every other per-member failure in the sync.

## Plan

- [ ] `countMergesInRange` exported from `@broject/core` (the #872
      counter, reused — not a second implementation).
- [ ] `rebaseMember` — pin the branch tip, count the merge commits in
      `<fork>..<head>`, refuse the member on a nonzero count or an
      unreadable one.
- [ ] the rebase target is the resolved commit-ish, not the bare name
      (bro-yi9sz — the same function, one rebase).
- [ ] tests: a member with a merge commit in its range is skipped with
      the #872 wording and its branch is NOT rewritten; a member without
      one still rebases.
