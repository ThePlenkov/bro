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

The rebase target is a fact, not a guess. Before the spawn, bro fetches
the PR's base ref in the fixer worktree and reads the tip:

- `git fetch origin <base>` — the base's remote-tracking ref is refreshed
  from the remote, in the common git dir, so every worktree sees it;
- `git rev-parse --verify origin/<base>` — the tip the fixer must rebase
  onto.

The spawn is **refused** when the fetch fails for a reason that is not
"this repo has no such remote" (a network error, a broken remote): a
rebase onto a known-stale base is worse than no rebase, and the next
drive pass retries the fetch. A repo with no `origin` remote (or a base
that lives only locally) is not a failure — there is nothing to fetch,
and the work order says so.

The tip travels into the work order, which is where the agent can act on
it: "rebase onto exactly `<sha>`; if `origin/<base>` no longer reads
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

The locked re-check in `spawnFixerAgent` stays: the guard closes the
window *before* the mutation, the locked re-check closes the window
*before* the spawn.

## Plan

- [ ] `fetchBaseTip(dir, base)` — fetch the base ref, read its tip;
      `skipped` for a repo with no remote (nothing to fetch), `err` for a
      fetch that failed.
- [ ] `spawnRebaseFixer` — fetch the base tip in the fixer worktree
      before the spawn; refuse the spawn on a failed fetch
      (`rebase-base-unavailable`); re-probe the PR after the fetch and
      end the pass as `conflict-resolved` when the conflict dissolved.
- [ ] `buildRebaseFixerPrompt` — carry the fetched tip; order the work
      as fetch → verify the tip → re-check the PR → rebase; forbid
      rebasing onto a tip that moved.
- [ ] `ensureFixerWorktree` — a guard callback; an occupied candidate
      checkout is never refreshed, and the verdict is `occupied`.
- [ ] `fixerLane` — the guard is the occupancy ladder read for that
      checkout; every fixer class (rebase, ci, sast) inherits it.
- [ ] tests: the base tip is fetched before the spawn and named in the
      work order; a failed fetch refuses the spawn; a conflict that
      dissolved after the fetch ends the pass; an occupied checkout is
      never refreshed.
