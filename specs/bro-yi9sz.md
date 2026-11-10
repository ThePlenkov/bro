# bro-yi9sz — a base that lives only as a remote-tracking ref is not a dead base

## Problem

The stack sync reads the base of every member **by name, locally**:
`refs/heads/<base>` (`carriesBaseHead`, `baseTip`), and the git calls
that take the name (`git merge-base <base> HEAD` in `forkPoint`,
`git rebase --onto <base> <fork>` in `rebaseMember`). Git's own
rev-parse never falls back from `main` to `origin/main` — the shorthand
`main` means `refs/heads/main`, and the remote-tracking branch is
`origin/main`.

So a repository whose default branch has **no local branch** — a
checkout that never created it, a default branch renamed on the remote —
reads as a dead base:

- `carriesBaseHead` cannot read the head → `undefined` → the member is
  skipped with "the head of `<base>` cannot be read";
- the chain's root guard refuses the whole chain ("the chain's root main
  does not exist; nothing to sync onto");
- `git rebase --onto main <fork>` fails, because there is no `main` to
  rebase onto.

Every member is skipped with a reason, and the chain is unsyncable.
The base is not dead — it is one fetch away.

## Design

### One resolver, the name stays the name

`baseRef(root, base)` answers the only question git cares about: which
ref can the base be read from?

1. `refs/heads/<base>` — the local head, when it exists. A local branch
   is the truth for a local rewrite.
2. `refs/remotes/<remote>/<base>` — the remote-tracking ref, for each
   configured remote (`origin` first). This is the case the bead is
   about.
3. nothing — the base does not exist anywhere. The old answer.

The resolver is used by every base read: `carriesBaseHead`, `baseTip`,
`forkPoint` and `rebaseMember`. The **name** is unchanged everywhere
else: the PR retarget and the recorded stack edge need the branch name,
not a ref — only the git reads take the commit-ish.

### The chain's root: local first, remote as the fallback

The root guard (bro-pax1l) refuses a chain whose root is a dead ref —
a member's recorded edge can name a branch that has since merged and
been deleted, and planning onto it is what froze the chain. That guard
keeps its teeth for member edges: a member's edge base is a **local**
branch by construction, and a deleted branch is not resurrected by a
stale, unpruned remote-tracking ref.

The **default branch** is the case the bead is about, and it gets the
fallback: when the default branch has no local branch but does have a
remote-tracking ref, the chain stands on it.

### The rebase target is a usable commit-ish

`git rebase --onto <base> <fork>` takes the new base as a revision.
With the resolver it takes `refs/heads/<base>` or
`refs/remotes/<remote>/<base>` — the same commit the plan saw, named in
a way git can resolve. The retarget still records the branch name.

## Plan

- [ ] `baseRef(root, base)` — local head first, then the remote-tracking
      refs; `undefined` when the base exists nowhere.
- [ ] `carriesBaseHead` / `baseTip` — read the base through the
      resolver.
- [ ] `forkPoint` — the base is resolved before git is asked where the
      fork is; an unresolvable base keeps the old behaviour (no fork, no
      rebase).
- [ ] `rebaseMember` — the rebase target is the resolved commit-ish.
- [ ] the chain's root — a local branch first, the default branch's
      remote-tracking ref as the fallback (bro-pax1l's guard intact for
      member edges).
- [ ] tests: a default branch that lives only as `origin/main` syncs;
      a member's base read resolves through the remote-tracking ref; a
      base that exists nowhere is still refused.
