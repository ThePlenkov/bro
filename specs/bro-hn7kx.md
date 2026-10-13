# bro-hn7kx — bro watch gates reads the branch plane, not the fleet registry

## Problem

`bro watch`'s gates section enumerated PRs only through `fleet.rows` —
and rows exist only for steps of OPEN molecules. With no open mols the
digest rendered `no PRs in the fleet` while the repo carried live open
PRs on `loop/*`/`work/*` branches (observed: 'no PRs' with 12 live
PRs). Same blindness family as bro-wg896 (the loop section reading a
registry instead of the real plane): the fleet registry is a custody
plane, not the set of open PRs.

## Design

Gates discovers PRs the way `bro drive` supervises them —
`candidateBranches(root)`: every worktree's branch plus local
`work/`/`loop/`/`stack/` branches (a PR can outlive its worktree), each
resolved through `rev.prsForBranch`. The fleet rows' already-resolved
PRs union in so a non-standard worktree branch still gates.

`openPrTargets(rev, repo, rows, branches, lookupErrors)` is the pure
discovery step — dedup by PR number, keep the row's rendered link when
present. Honesty rules unchanged: an incomplete branch listing or a
failed `prsForBranch` lands in `lookupErrors` (renders `no PRs
resolved` + warning, never a false quiet); the empty case now reads
`no open PRs on fleet branches`, matching drive's vocabulary.

Rejected alternative: a repo-wide `openPrs` facade method — one host
call instead of N, and it would catch remote-only branches, but it
gates foreign/human PRs too, which is outside the section's fleet
scope (spec bro-vf1j: "PR discovered through the fleet"), and it costs
a new ReviewFacade capability across connectors. Revisit if the
branch-plane gap (PR on a deleted local branch) ever matters in
practice — drive has the same blind spot, so the fix would be shared.

## Plan

- [ ] `packages/cli/src/commands/watch.ts` — `openPrTargets` discovery
      (rows ∪ `candidateBranches` → `prsForBranch`), `gatesPlane`
      threads `lookupErrors` through, empty-state copy
- [ ] `watch.test.ts` — discovery unit tests (row-less discovery,
      union/dedup, per-branch lookup failure) + updated render copy

## Acceptance

- `bro watch` in a repo with open fleet-branch PRs and no open
  molecules lists every such PR's act gate — no more `no PRs` while
  `gh pr list` shows live ones.
- A failed branch listing or lookup warns; it never reads as an empty
  PR set.
