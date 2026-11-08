# bro-pax1l — the chain's root is a branch that still exists

## Problem

`bro stack sync` roots the chain at the FIRST member's base. When that
base is a branch that no longer exists — the member has already merged,
or the arc's own base has merged and been deleted — the root is a dead
ref, and the sync cannot run.

Measured on the router stack, after the operator merged the bottom layers
bottom-up and GitHub deleted their branches:

- `feat/router-routes` (the base) merged into `main`; the branch was deleted.
- `stack/router/1-code-health` and `stack/router/2-token` merged in turn;
  their branches were deleted.
- The remaining members — `stack/router/3-tool-use` ([#936](https://github.com/ThePlenkov/bro/pull/936))
  and `stack/router/4-client` ([#942](https://github.com/ThePlenkov/bro/pull/942)) —
  had to be retargeted onto `main` and onto their own parent.

`bro stack sync router` said:

```text
stack/router/3-tool-use rebase onto feat/router-routes failed — aborted; owner resolves on enter
```

`feat/router-routes` was the merged base's branch — deleted four minutes
earlier. The chain's root pointed at a dead ref, so the sync refused to
move the members that were still in the chain.

Worse, one sync run BEFORE the edges were refreshed did not refuse: it
rewrote `stack/router/3-tool-use` onto the OLD trunk, so the merged
layers' work fell out of the member's history and the member's PR showed
the whole arc as its own diff.

## Design

### The root is the default branch when the first member left the chain

`chainRootBase` reads the first member's recorded edge, then its PR base,
then the default branch. A member that MERGED has left the chain — the
codebase already says so everywhere else (`prState !== 'MERGED'` is how
`stack list` reads "still here" and how `stack merge` picks the ones it
may land). Its base is the branch it landed ON, and that branch is gone.

So a merged first member gives the chain the default branch — the same
answer the sync PLAN already gives the member that follows ("its
successor's base becomes the nearest lower member still open, or the
default branch"):

```ts
const first = members[0];
if (first === undefined) return defaultBase;
if (first.prState === 'MERGED') return defaultBase;
```

### A dead ref is never a base

The merged member is not the only way a ref dies. The arc's OWN base
merges before the layer above it does, and the platform deletes it — so
the bottom member, still open, carries an edge that names a branch which
no longer exists. Planning onto that edge is the same failure one layer
lower: the sync cannot rebase or retarget a member whose base is gone.

So the candidate must be a branch that still EXISTS. The chain falls
back to the default branch — where the dead branch's work landed:

```ts
for (const candidate of [first.edgeBase, first.prBase]) {
  if (candidate !== undefined && alive(candidate)) return candidate;
}
return defaultBase;
```

`alive` is the git truth, read by the caller (`refs/heads/<branch>`
resolves), so `chainRootBase` stays a pure function of its inputs: the
same list of members and the same default branch always give the same
root.

A chain that never merged keeps its own root — the arc's own branch, not
the default branch.

### The edge is what the member is based on

The recorded edge (`<git-common-dir>/bro/stack/<branch>`) is the member's
own base: it is written when the member is created and rewritten when the
sync retargets it. After the bottom layers merged, the members that
remain are based on the default branch and on each other — and their edges
say so.

### The fork point stays the reflog's answer

Which commits belong to the member is still `forkPoint`'s business: the
base's reflog remembers the tip the member was built on, so a rewritten
base does not drag its old commits along. This change only says WHICH base
the member sits on.

## Plan

- [x] `chainRootBase` gives the default branch to a chain whose first
      member merged.
- [x] `chainRootBase` refuses a candidate that no longer exists.
- [x] tests: a chain whose first member merged roots at the default
      branch; a dead edge falls back to the default branch; a chain that
      never merged keeps its own root.

## Verify

- `npx tsx --test packages/cli/src/commands/stack-root.test.ts` — a chain
  whose first member merged roots at the default branch; a dead edge falls
  back to the default branch; a chain that never merged keeps its own root.
- `npx tsx --test packages/cli/src/commands/stack.e2e.test.ts` — the
  cascade's own end-to-end story still holds.
- `bro stack sync <name>` after the bottom members merged: the rest are
  rebased onto the default branch (or their parent), their PRs are
  retargeted, and a second run says "in sync".
- The repo's CI, exactly as GitHub runs it.

## Non-negotiables

- **A dead ref is never a base.** The sync must not name a branch that
  does not exist — neither the merged member's dead edge nor the arc's
  dead base. The chain falls back to the default branch, where that
  work landed.
- **The merged member's work stays merged.** A member that left the chain
  keeps its commits in the default branch; nothing is rewritten out of the
  chain's history.
- **The tool does the move.** The cascade is bro's own work, not a
  hand-rolled rebase.

## Risks named up front

- **The PR state is the truth about the chain.** A host that cannot be
  reached reads every member as unmerged — the root then falls back to
  the first member's edge, the conservative answer.
- **A member with no PR at all** reads as unmerged too: it is still in the
  chain until something says otherwise.
- **A chain that roots on a LIVE branch other than the default** moves onto
  the default branch once its first member merges — the same answer the
  plan gives a merged member ("the nearest lower member still open, or the
  default branch"). A chain whose root branch outlives its first member
  wants the root kept; that is the one case this rule answers differently,
  and it is the case the cascade does NOT create (the cascade deletes the
  root when it merges the layer below it).
- **A branch that exists only as a remote-tracking ref counts as dead.**
  The sync's own operations (the head check, the rebase) read local
  branches; a ref the plan names but git cannot resolve is a dead ref.
  A repository whose default branch has no local branch is a separate
  gap (tracked as its own bead).
