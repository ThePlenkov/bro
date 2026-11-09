# bro-by8d3 — the rebase fixer must rebase onto the base's tip, not onto a stale ref

## Problem

`bro drive` spawns a rebase fixer when an orphaned PR is `CONFLICTING`
(spec bro-glkes, `packages/cli/src/commands/drive.ts`). The fixer rebases
the PR branch onto its base and force-pushes. Two things went wrong on
2026-11-07, and both are structural — neither is a matter of the agent
"trying harder":

1. **The rebase landed on a stale base.** The fixer fetched `origin/main`
   once, early, and rebased onto that tip while `main` had already moved:
   it rebased onto `780fc295` while main was at `96fca6d1`. The pushed
   branch was still conflicting, so the PR went back to `CONFLICTING` and
   the next drive pass spawned another round on the same stale target.
   The repo's remote-tracking refs are as old as the last fetch *anybody*
   in the repo ran — the drive lane never fetched the base at all, so the
   fixer's target was whatever the last unrelated fetch left behind.

2. **The fixer reset a branch another session owned.** The fixer ran in
   the worktree the operator's own session was sitting in, and its
   `git reset --hard` silently discarded an in-progress merge of the same
   branch (01:09). The commit was recoverable only from the reflog.

The second class is mostly closed already: `ensureFixerWorktree` refreshes
a standing checkout with `git merge --ff-only` (never a reset) and
refuses a dirty or mid-merge tree, and the spawn is skipped when the
occupancy ladder proves a live owner. What is still open is the
**ordering**: the drive refreshes (moves) the branch in
`ensureFixerWorktree` *before* the occupancy re-check that
`spawnFixerAgent` runs under the locks — so the one mutation bro makes
to a foreign worktree happens exactly where the bead says it must not.

And what is still entirely open is the stale base: nothing in the drive
lane fetches the base ref, and the work order asks the agent to fetch
"the PR branch too" without telling it which tip it must rebase onto or
what to do when the base moves under it.

## Design

### The base is fetched by bro, at the last moment, and named

The rebase target is a fact, not a guess. Before the spawn, bro resolves
the PR's base in the fixer worktree and reads its tip:

- `git fetch origin <base>` — the base's remote-tracking ref is refreshed
  from the remote, in the common git dir, so every worktree sees it;
- `git rev-parse --verify origin/<base>` — the tip the fixer must rebase
  onto.

The base is resolved the way git can actually read it: `origin/<base>`
(fetched first), then another remote's tracking ref, then the **local
branch**. A base that exists nowhere is an **error**: the spawn is
refused, because a rebase without a target is not a rebase. (A repo with
no remote at all is not an error — the local branch is the base, and the
work order says so instead of sending the fixer after a remote ref that
does not exist.)

The tip travels into the work order, which is where the agent can act on
it: "rebase onto exactly `<ref>` at `<sha>`; if `<ref>` no longer reads
that sha, the base moved under you — re-check the PR's mergeable state,
and if it reads `MERGEABLE` the conflict dissolved: stop, do not rebase."

### The PR is re-checked against the tip just fetched

GitHub computes `mergeable` against the *remote* base tip, so a fresh
`prMeta` read is the authoritative conflict state — but only if it is
read *after* the base fetch that the rebase will use. The spawn path
therefore probes the PR twice around the fetch:

1. before the lane (a settled PR never pays for a worktree);
2. after the fetch — if the base moved during the fetch and the conflict
   dissolved with it, the pass ends as `conflict-resolved` and no agent
   is spawned at all. A conflict that evaporated is not work.

A PR **retargeted** while the fetch ran is caught by the same probe: the
base bro resolved is not the base the PR wants, so the new base is
resolved too — a tip is never paired with a name it does not belong to.

### No branch of a live session is ever moved

The occupancy ladder already knows who is where (a live agent, a
supervisor marker, the worktree's claim marker, a fresh `.work` marker, a
live `/proc` cwd). The drive consults it **before** it touches the
worktree, not only after:

- `ensureFixerWorktree` takes a guard: for a candidate checkout the
  guard may report an owner, and the ensure path then hands back
  `occupied` instead of fast-forwarding that checkout's branch. The
  branch of a live session is never moved — not by a reset (already
  gone), not by a fast-forward either.
- the guard applies to the checkout that would actually be refreshed: a
  dir standing on **another** branch is not this branch's checkout, and
  it must not consume the guard — the namespaced fallback still has to
  be tried.
- the guard and the refresh share the **occupancy locks** (the registry
  lock every claimant serializes on, plus the worktree's claim lock): a
  session that claims the checkout after the guard would otherwise have
  its branch moved under it.

The locked re-check in `spawnFixerAgent` stays: the guard closes the
window *before* the mutation, the locked re-check closes the window
*before* the spawn.

## Plan

- [x] `fetchBaseTip(dir, base)` — resolve the base the way git can read
      it (`origin/<base>` fetched, another remote's tracking ref, the
      local branch) and read its tip; an unresolvable base is an error.
- [x] `spawnRebaseFixer` — resolve the base in the fixer worktree
      before the spawn; refuse the spawn on a failed fetch
      (`rebase-base-unavailable`); re-probe the PR after the fetch and
      end the pass as `conflict-resolved` when the conflict dissolved;
      re-resolve the base when the PR was retargeted mid-fetch.
- [x] `buildRebaseFixerPrompt` — carry the resolved ref + tip; order
      the work as fetch → verify the tip → re-check the PR → rebase;
      name the review host's own CLI for the merge-state read.
- [x] `ensureFixerWorktree` — a guard and a lock; an occupied candidate
      checkout is never refreshed, and the verdict is `occupied`.
- [x] `fixerLane` — the guard is the occupancy ladder read for that
      checkout; every fixer class (rebase, ci, sast) inherits it.
- [x] a dir the pass added and nobody claimed is retired when the pass
      ends without a fixer.
- [x] tests: the base tip is fetched before the spawn and named in the
      work order; a local base is rebase-able; a failed fetch refuses
      the spawn; a conflict that dissolved after the fetch ends the
      pass; an occupied checkout is never refreshed; the GitLab work
      order names `glab`, never `gh`.
