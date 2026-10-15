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
`work/`/`loop/`/`stack/` branches (a PR can outlive its worktree). The
fleet rows' already-resolved PRs union in so a non-standard worktree
branch still gates.

Discovery prefers the new optional `ReviewFacade.openPrs(repo)` — one
`gh pr list --state open`/`glab merge_requests?state=opened` call
returning `{pr, headRef}` rows — filtered to the fleet: headRef ∈
candidate branches (worktree branches) OR matching the fleet prefixes
(so a remote-only `loop/x` head counts — its local branch may be
gone). A host without `openPrs` falls back to the per-branch
`prsForBranch` scan. The bulk path exists because the heartbeat pays
one spawn per candidate branch otherwise — on a repo carrying ~90
fleet branches that serializes minutes of `gh` calls into every tick.

`openPrTargets(rev, repo, rows, branches, lookupErrors)` is the pure
discovery step — dedup by PR number, keep the row's rendered link when
present. Honesty rules unchanged: an incomplete branch listing, a
failed `openPrs`, or a failed `prsForBranch` lands in `lookupErrors`
(renders `no PRs resolved` + warning, never a false quiet); the empty
case reads `no open PRs on fleet branches`, matching drive's
vocabulary.

Rejected alternative: gate every open PR unfiltered — foreign/human
PRs are outside the section's fleet scope (spec bro-vf1j: "PR
discovered through the fleet") and would bill act-gate probes nobody
asked for. Drive keeps its own `candidateBranches` enumeration (a PR
on a deleted local branch stays its blind spot) — adopting `openPrs`
there changes supervision semantics, not just reads; out of scope.

## Plan

- [ ] `packages/core/src/review.ts` — optional `openPrs(repo)` on
      ReviewFacade; github + gitlab connectors implement it
- [ ] `packages/cli/src/commands/watch.ts` — `openPrTargets` discovery
      (rows ∪ bulk/fallback branch scan), `gatesPlane` threads
      `lookupErrors` through, empty-state copy
- [ ] `watch.test.ts` — discovery unit tests (row-less discovery,
      union/dedup, per-branch failure, bulk filter + failure) +
      updated render copy

## Acceptance

- `bro watch` in a repo with open fleet-branch PRs and no open
  molecules lists every such PR's act gate — no more `no PRs` while
  `gh pr list` shows live ones.
- A failed branch listing or lookup warns; it never reads as an empty
  PR set.
