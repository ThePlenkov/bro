# bro-oy3k1.1 — the rig engine: one lifecycle state machine per work item

## Problem

Three daemons own fragments of the same lifecycle and each reinvented
its seams:

- **loop** (`bro flow loop`) — claim → worktree → spawn → PR → merge →
  close. Its state lives in `loop.lock`, loop-run records, and bead
  claims; its scheduler is a serial foreground process.
- **drive** (`bro review drive`) — PR supervision: gate polls, fixer
  spawns, merge on green. Its state lives in `drive.json`, per-PR
  heartbeat markers, and the agents registry.
- **convoy** (`bro flow convoy`) — molecule DAG drainage: `convoy next`
  already recomputes the next step from durable state — the only leg
  that is honestly stateless today.

The gaps sit at the seams, observed live: `bro work enter` claims to the
session (a spawned worker cannot then take the claim), `fleet agents up`
only resolves existing worktrees (a manual `git worktree add` is
required mid-flow), drive counts `bro watch` monitors as worker
occupancy (dkw3e), drive's fixer spawn is gated on threads so a
check-fail-only PR is orphaned (njyn8), and there is no human-approval
input to the merge gate (3vy93). Worktree dirt behind origin's HEAD
silently fabricates phantom reverts (6k3f4).

## Design model

**Worktree = materialized WBS.** Bead dotted-ids are WBS codes, a
worktree per bead is a node, a stack branch is an edge. The rig engine
is the single machine every surface drives; loop/drive/convoy are
*policies* over it, not daemons of their own.

**Temporal at home.** The substrate already exists under other names —
bead = workflow instance, `bd ready` = task queue, spawned session =
activity (bounded, lease = retry), mailbox drop = signal
(to/kind/in-reply-to), pulse + act-wait = timer, `events.jsonl` +
registry + heartbeat = history. Temporal itself does replay, not
process-resume — `convoy next` is already "recompute the next step from
state". **Design verdict (epic): fresh session + replay from durable
state is the resume model; literal `devin -r` session resume is a
connector-level optimization for expensive context, never the
default.**

## Item states

One state machine per work item (a bead, or a molecule step — a bead
whose parent is a molecule). Authoritative state lives in the store;
`events.jsonl` is the transition log (writers emit AFTER the
transition lands — `emitLifecycle` is the only write path).

```
queued ──claim──> claimed ──spawn──> working ──pr-open──> pr_open
  ^                 │         ▲  ▲                       │    │
  │                 │         │  │ gate ticks:           │    │
  │                 │         │  │ threads/ci/sast/      │    ▼
  │                 │         │  │ reviewers/human    gate_blocked
  │                 │         │  │                       │
  │                 │         │  └──push── working <──fixer──┘
  │                 │         │                            │
  │                 │         └──────── green <────────────┘
  │                 │                      │
  │                 │                      ▼
  │                 │                    merged ──> closed
  │                 │
  │                 └── (every non-terminal state) ──park──> parked
  │                                                        │ release
  └────────────────────────────────────────────────────────┘
  (any non-terminal state) ──────────────────────────────> lost
     lease dead, pid gone, worker superseded — reapable;
     re-queue is a policy decision, never silent (below)
```

- `queued` — open, unclaimed, in the ready set (deps satisfied).
- `claimed` — lease held by a session or worker; no live worker yet.
- `working` — registry entry `spawned`/`running` under the claim.
- `pr_open` — a PR for the item's branch exists; the gate evaluates.
- `gate_blocked` — a *settled* blocker signal: unresolved threads,
  failing checks, SAST findings, **or a required human approval
  outstanding** (3vy93 — the gate accepts an approval input,
  `act.approval`; a check-failure-only PR blocks here identically to a
  thread-blocked one — njyn8, no fixer spawn may key on threads alone).
  Pending checks/reviewers are *settling*, not blocked — the item stays
  `pr_open` until every signal resolves; a fixer never launches on a
  still-running reviewer.
- `green` — `exit_gate=OK`; merge pending. Merge is an edge, not a
  state — it either lands (`merged`) or bounces back to `gate_blocked`.
- `parked` — explicitly suspended with a resume payload (the
  interrupter state); `release` returns it to `queued`. **Every**
  non-terminal state may park — `working` and `pr_open` are the common
  real-world suspension points (a worker interrupted mid-flight, a PR
  waiting on a human); `park` records the suspend-from state and the
  wake predicate so `release` can report what it interrupted.
- `lost` — lease expired or worker dead mid-flight. The sweep reaps
  the record; **re-queue is owned by the loop policy**: `lost →
  queued` fires only when the item's claim lease has expired AND its
  registry entry is terminal (`exited`/`lost`/`stopped`) — a monitor
  or parked frame never counts (dkw3e). The transition emits its
  journal row with `detail.cause` so the re-entry is auditable; a
  lost item is never silently retried.
- `merged` — settled, not terminal: the only edge left is `merged →
  closed` (cleanup/ledger finalization — a squash-merged branch
  deletes, the bead's close reason lands). It never re-enters work.
- `closed` — terminal; no outgoing edges.

Every edge emits its `LifecycleKind` (claim/worktree/spawn/agent-exit/
pr-open/gate/verdict/merge/park/release/close). The journal is the
audit trail, **not** the authority: re-derivation reads the beads
claims, git-common registry, worktrees, and the forge — a lost or
compacted journal row must never change the verdict, it only erases
provenance. A transition that cannot journal is still suspect (an
unaccounted edge), but absence of the row is never state.

## Frames

Every work context is a frame `{context, own queue, result}`; frames
form a stack; each frame owns a queue; a queue item can become a frame.
The interactive session is frame #0.

- `bro work drill down` = push frame; `--result` on `up` enqueues the
  result onto the parent queue.
- `bro queue <subject>` (child bead .2) = intake verb — enqueue an item
  on the current frame's queue.
- Waiting is explicit state, never a blocked syscall: a frame that
  awaits an external event parks with a wake predicate; the wake signal
  pops it back (stack-of-queues interrupter — the traversal order that
  services gate updates while a descendant works).

Two traversal orders: **queue of stacks** (the sequencer — a
ready-queue of dep-chains drained parent→child; convoy's DAG walk) and
**stack of queues** (the interrupter — waiting frames resume LIFO).

## The engine's one verb

```
rig next <item?> → step | gate | wait | done | blocked
```

Recomputed from durable state, idempotent, stateless — any signal or
timer may re-enter. `convoy next` already is this verb for the DAG
case; the spec of record for all policies. `rig next` never waits: it
returns the current verdict and exits; *waiting* is a parked frame or
a timer marker, never a held process.

## Policies

Policies are `{predicate → action}` sets over item state, evaluated by
the engine — not daemons:

- **loop policy** — `queued → claim+spawn` (one transition — the spawn
  owns worktree creation AND the claim; `bro work enter`'s
  session-claiming splits this today and is the bug), then `working →
  pr_open` on push.
- **drive policy** — `pr_open → gate_blocked` on any *settled* blocker
  signal (threads, failed checks, SAST, missing human approval — never
  a pending one); `gate_blocked → working` spawns a fixer **on any
  blocker kind** — check-only failures spawn fixers exactly like threads
  (njyn8). The fixer works the PR's own branch: its push re-enters
  `pr_open` (the existing PR is retained — never a duplicate PR) and
  the gate re-evaluates. Occupancy counts worker-kind registry entries
  only — monitors and watchers never count (dkw3e). `green → merged`.
- **convoy policy** — step drain: `convoy next`'s recomputation is the
  reference implementation; a mol root's `ready` steps are `queued`
  items, `gates` are human-kind items only a human verdict releases.

## Signals and timers

- **Signal** = mailbox drop (`to`, `kind`, `in-reply-to`) — re-enters
  the engine; a spool, not an interrupt: nothing is promised per-tick.
- **Timer** = pulse ticks and `act wait` markers — the same thing: a
  recorded wake intent that re-runs `rig next`. Per-PR `act wait` OR
  drive heartbeat coverage — one poller beats N waiters.
- **History** = `events.jsonl` — replay source for any fresh session.

## Resume semantics

Worker pushes PR → arms detached `act wait` → takes the NEXT item —
waiting costs a timer marker, not a session. On settled-blocked the
policy resumes the work as a fixer — a fresh session carrying
PR+thread context. Daemon-side, resume restores *recorded intent*
(`fleet resume` pass — `drive.json` want-marker, dead watch markers),
never invents work and never auto-spawns the loop.

## Guards folded in

- Checkout-behind-origin warn (6k3f4): a `rig next`/guard probe reads
  `HEAD` vs `origin/<branch>` for the item's worktree and surfaces
  `stale` before interpreting file state.
- Caps stay: `fleet.maxConcurrent`, `agents.devin.maxSessions`.

## Non-goals

- No literal process/session resume as the default path.
- No second store — bd issues + git-common journals remain the durable
  state; the engine adds the transition table, not another database.
- No daemon-per-policy — `bro daemon` owns process supervision; the
  policies are evaluated, not resident.

## Beads carved

- `.1` this spec.
- `.2` frame-scoped queues + order/rank + `bro queue <subject>`.
- `.3` waiting-state on frames (interrupter; absorbs zsmwq's
  round-robin direction).
- `.4` spawn owns enter+claim+spawn as one transition.
- `.5` the `rig next` re-entry point — loop/drive fold in as policies.
