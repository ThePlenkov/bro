# bro-jis0c — lane formula: closure-first

Hard ceiling on TOTAL open fleet PRs, no new claims while above it,
worktree/branch reaped on close.

## Problem

The loop's WIP bound counts the wrong set. `loop.maxOpen` caps the
gate STACK — this run's own members — but a member leaves the stack
(park/fail) while its PR stays open, and dead runs, other sessions,
and `bro work enter` trees all push PRs the stack never sees. Result:
unbounded open-PR accumulation (38 open / 48 worktrees / 1.1G .git at
the incident) and a conflict-resolution multiplier that grows with
every stale head — each open branch on shared files pays a rebase
round against every main movement (operator clarification: "merge
price" = conflict-resolution time, not review approvals).

## Design

The tick becomes closure-first. Order per pass:

1. **Service the gate stack** (unchanged mechanics): merge on green,
   fix round on threads, rebase on CONFLICTING, oldest-first. On a
   `closed` member the remote branch is deleted and the worktree +
   local branch reaped in the same pass (a tree hosting a live
   process stays — bro-1usa8; a dirty tree reports as a tail, never a
   silent deletion). Merged heads already reap; an externally-merged
   head now also gets its remote branch deleted (the `act merge`
   path carried `deleteBranch`, an outside merge does not).
2. **Reconcile orphaned fleet PRs** — open PRs on fleet heads
   (`work/`, `loop/`, `stack/`, `fix/bro-`) that are NOT on this run's
   stack (a stack member protects by PR number AND by branch — a
   worker-pending member has no number yet). The branch slug resolves
   a bead row (`loop/<slug>`, `stack/<name>/<n>-<slug>`, or a bead-id
   prefix match for work//fix/ heads; a tail two different beads
   prefix is ambiguous and keeps). Bead **closed** → the PR is dead
   weight: `closePr` + remote branch delete + local branch/worktree
   reap — and the verdict is re-read against a fresh listing before
   the close, so a bead reopened mid-pass is never buried. Bead
   **missing** on a `loop/`/`stack/` head (deterministic bead
   namespaces) → same verdict; on `work/`/`fix/` heads a missing row
   is unverifiable → keep. Bead **open/in_progress/deferred** → keep
   (a parked member's snooze wakes back to its PR) — a live PR is
   `bro drive`'s territory; the loop only buries the dead. A head
   whose body carries the `bead:` provenance trailer answers as its
   whole membership instead of its lead: the PR keeps while ANY
   stamped member id is not positively closed. A `loop/` head is
   stamped at open, so membership that can't be read there keeps —
   an unproven batch is never a burial order; on the other
   namespaces a missing trailer falls back to the single-bead
   verdict. Cleanup never force-removes a worktree a live process
   roots or uncommitted changes sit in, and every failed delete
   lands in the tails. Hosts without `closePr` report once per PR
   per run and keep counting.
3. **Ceiling check, then claim** — `loop.maxOpenTotal` (default 10,
   `0` = off) counts every open PR on a fleet head, one
   `rev.openPrs(repo)` listing per interval (per-branch scan over
   local AND `ls-remote` heads as the no-listing fallback — a
   remote-only head another clone pushed still counts; any
   enumeration gap reads as 'unknown'), PLUS each
   admitted-but-PR-less claim holding
   a reservation file in the common git dir (`bro/ceiling.reserved/`,
   written under `loop.ceiling.lock` at admission — the lock alone
   released at the check, so two loops in linked worktrees could both
   read n<max inside one claim→spawn→open window). A reservation is
   stamped with the member's branch once the clump lands, consumed
   when that branch's PR lists, released on every non-member outcome
   and on stack splice, and swept when its owner pid is dead.
   Reservations coordinate loops in this clone's worktrees; separate
   clones still share only the remote listing. Count ≥ ceiling →
   `claims held — ceiling N open + R reserved/M` (once per episode)
   and the push half is skipped — but an empty queue still reports
   drained first; gate service and reconcile still run. A listing
   that can't be produced holds too — a hard ceiling that cannot see
   admits nothing. Under the ceiling the normal admission order
   applies: fleet cap → disk floor → claim.

**Serial by default** — `loop.maxOpen` default moves 3 → 1: the
single in-flight branch forks from the freshest main, which is the
cheapest possible conflict exposure. Parallelism is the budgeted
mode: `--max-open N` still widens it, and the total ceiling bounds
the repo-wide count either way.

**Merge bar (documentation)** — the price of a merge is already the
gate: zero unresolved threads, required checks green on the current
head (`--match-head-commit` pins the evaluated sha), no SAST
findings, not draft, not BEHIND. A bead with unpushed commits or a
dirty worktree fails its own work contract before the gate is ever
reached — the pushed head is all that merges. No approval
requirement: automation cannot self-approve, and the operator
confirmed the price to raise is conflict time, not sign-off.

**Space hygiene** — `loop.worktreeWarn` (default 40, `0` = off): the
run warns once the linked-worktree count crosses the mark; the
reconcile/settle reaps do the shrinking.

## Out of scope

- Adopting live orphaned PRs into the loop's stack (the "finish"
  verdict) — `bro review drive` already owns orphaned-PR supervision;
  the loop buries dead ones.
- Strict-head auto-update before merge (operator's evaluation item,
  not acceptance).
- Metrics: "conflict rebase rounds per merge ≤ 1" is observed from
  the lifecycle `gate` journal rows (already emitted), not new code.

## Plan

- [ ] `packages/loop`: `maxOpenTotal` + `worktreeWarn` config,
  `maxOpen` default 1, pure `ceiling.ts` (head-prefix set, hold
  verdict, head→bead-slug resolution, reconcile verdict) + tests
- [ ] `ReviewFacade.closePr?` — core contract, github (`gh pr close`)
  and gitlab (`state_event=close`) connectors
- [ ] `loop.ts`: `--max-open-total` flag, ceiling hold in tryClaim,
  reconcile pass, closed-member remote-branch + reap, externally-
  merged remote delete, worktree-count warn
- [ ] e2e: fakehost `openPrs`/`closePr`; ceiling-hold and reconcile
  scenarios
- [ ] skill/doc: loop SKILL.md `maxOpen` default + the ceiling knob
