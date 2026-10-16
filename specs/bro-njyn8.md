# bro-njyn8 — drive must see PRs whose local branch is gone

`openFleetPrs` enumerates drive candidates through
`candidateBranches(root)` — worktree branches plus local
`work/`·`loop/`·`stack/` branches. The check-side machinery already
handles an orphaned failing head (`blockedVerdict` → `ci-fail`/`sast`
→ `spawnCiFixer`/`spawnSastFixer`), but the enumeration leg has a
hole: when the owning bead closes and cleanup reaps the local
`work/<bead>` branch, the remote head — and its still-open PR — no
longer appears in the candidate set. `openFleetPrs` never calls
`prList` for it, `blockedVerdict` never sees it, and the PR sits
reported as blocked (or simply untouched) forever with zero fixer
rounds.

This is exactly the post-merge lifecycle of every drive-managed PR:
the worktree and local branch are transient by design, the remote
head is the durable artifact. Enumerating only local state means
drive is blind to precisely the population it exists to supervise.

## Change

`candidateBranches` additionally lists remote-tracking fleet refs —
`git branch -r --list 'origin/<prefix>*'` — and strips the `origin/`
prefix before adding to the set (dedup with local names is then
free). A remote head with no local branch is now a candidate; its
open PR reaches `blockedVerdict` and the ci/sast fixer classes.

## Invariants

- Only fleet-prefixed remote refs (`origin/work/*` etc.) count —
  `origin/feature/x` is not drive territory.
- `headMatches` compares `p.headRefName === branch` — PR head names
  carry no remote prefix, so the stripped form matches unchanged.
- A failed remote listing degrades `complete` the same way a failed
  local listing does — never a silently drained set.

## Rejection test

- `git update-ref refs/remotes/origin/work/bro-orphan HEAD` with no
  local `work/bro-orphan` → `candidateBranches` yields
  `work/bro-orphan` (stripped, never `origin/…`); a local+remote
  `work/bro-a` dedups to one; non-fleet `origin/feature/x` stays out.
