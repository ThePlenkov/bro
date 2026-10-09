# bro-zsmwq — loop task-stack round-robin

## Problem

`bro loop`'s claim cycle is strictly serial: `runItem` ends in
`driveGate`, which blocks inside `waitForGate` for up to
`loop.mergeTimeoutMin` (45m default) per gate round. While a gate sits
pending — CI running, an AI reviewer mid-flight, mergeability still
computing — no bead is claimed: the merge window is pure orchestrator
idle. And when the loop does move on (park, `--max`, operator kill),
the open PRs it leaves accumulate on independent `loop/*` branches:
merge conflicts on shared files are guaranteed (seen live on sverka —
#329/#332 conflicted once the arena series landed), and `bro drive`
then spawns fixer sessions into the same worktrees the loop owns — the
loop↔drive collision from retro bro-0aa87.

The old act skill's round-robin idea: avoid gate idle by switching to
the next task, but *return* to a stack member when its gate produces
an update. This bead makes the loop run that scheduler.

## Design

A `bro loop` run owns an ordered **gate stack** — one member per PR
pushed this run, entry order = service priority (oldest first). Each
tick the scheduler does two things:

1. **Service pass** — poll every member once (`fetchPrActState` +
   `evaluateExitGate`, no `waitForGate` blocking) and act on the
   verdict, oldest first:
   - `MERGED` → finalize (externally landed) — merge, bead close,
     worktree/branch drop, marker end, slot freed
   - gate green → `bro act merge` → same finalize
   - `CLOSED` → note + park
   - open threads + rounds left → fix round: the agent respawns in
     that member's own worktree; the member re-enters the gate with a
     fresh budget
   - `BEHIND` as sole blocker + mergeable → `updateBranch`, with the
     same landing detection `waitForGate` has (a still-old headSha
     reads as "update landing", keep waiting)
   - `CONFLICTING` → rebase round: fixer respawn with a rebase prompt
     (rebase onto the PR's base, resolve, push) — conflicts surface
     while the member's context is fresh instead of weeks later
   - still pending past the member's `mergeTimeoutMin` budget → park
   - fetch exhausted (3 consecutive failures) → park
2. **Push** — while the stack is under `loop.maxOpen` and a claimable
   bead exists, the push path runs exactly as today (claim → worktree
   → bootstrap → agent → PR discovery); the PR joins the stack as the
   newest member instead of entering `driveGate`. No-PR outcomes
   (agent verdict, failure, lookup error) settle inline, unchanged.

The run ends when the queue is drained (or `--max` claims spent) AND
the stack is empty — pending members wait out their own budget, so a
drained queue with open gates drains the stack too (the tail wait
today's last item already pays).

**Bound — `loop.maxOpen`** (config + `--max-open`, default 3, ≥1).
At cap pushes stop and only gate service runs until a merge frees a
slot. `maxOpen: 1` is the near-serial shape — one PR in flight, the
scheduler services it between claims.

**Gate budget** — per member per gate entry: `since` resets on each
fix/rebase round (the member re-entered the gate, same as a new
`waitForGate` round today); an update-branch push does not extend it
(the old wait's deadline covered update loops the same way).

**Watch markers** — each member arms a `watchBegin` marker at push
(the bro-z0k2u shape: `merge:true`, `cleanup:true`, `workdir` =
member worktree) and `watchEnd`s it when it leaves the stack — landed
or parked. A dead loop leaves dead markers; `bro act rearm`
resurrects them as `act wait --merge --cleanup` rooted in the member
worktree — the same recovery contract the blocking wait had.

**`--stack`** is orthogonal: merges still cascade via `syncAfterLand`
(now triggered on member landings), `maxOpen` bounds open PRs
identically, and a member's rebase/conflict rounds target the PR's
declared base — which stack sync may have retargeted.

**Module split** — the decision table is pure and lives in
`@broject/loop` (`schedule.ts`: `memberAction(snapshot, member,
opts)` over a minimal structural `GateSnapshot` — the package stays
act-free; `commands/loop.ts` adapts `PrActState`/`ExitGate` into it).
The IO shell — fetch, spawn, merge, notes — stays in
`commands/loop.ts`. Fix and rebase respawns share the member's
`loop.fixRounds` bound: a round is an agent respawn on the member.

Concurrency stays serial: one agent spawn at a time, one loop process
owning the whole stack — no second supervisor on these worktrees.

## Non-goals

- No parallel agent spawns — while an agent runs the scheduler is
  inside that action; concurrent spawning is a fleet-budget question
  for a later bead.
- `bro drive` unchanged — orphaned-PR supervision stays its job; this
  only removes the loop's *need* for it on the loop's own PRs.
- No drive↔loop worktree exclusion protocol (bro-0aa87's own bead).
- `mergeTimeoutMin` semantics preserved per member; no global run
  deadline added.

## Validation

- `schedule.test.ts` (new, `@broject/loop`): the decision table —
  pending→wait, pending+deadline→park, threads→fix bounded by
  fixRounds and the act cap, `BEHIND`→update + landing-wait,
  `CONFLICTING`→rebase bounded, MERGED/CLOSED→settle, settled-blocked
  →park naming blockers.
- `config` num(`maxOpen`, ≥1).
- `loop.e2e.test.ts` (fake host extended for per-PR state + an event
  log):
  - round-robin: A pending → B still claims/lands → A lands after its
    checks clear (merge order proves B didn't wait on A's gate);
  - `--max-open 1`: B's agent spawns only after A's merge (event
    order proves the bound);
  - `CONFLICTING` → rebase fixer spawn in the member's worktree →
    lands;
  - `BEHIND` → update-branch → lands;
  - existing serial suite keeps passing (the marker test reads the
    same armed shape).
- `bro spec check bro-zsmwq` passes (this file).
- `npm run build`, `npm run typecheck`, `npm test`, `check:plugins`,
  `check:embedded`.
