# bro-nspj7 — loop batch claims: N compatible beads, one worker, one PR

## Problem

`bro loop`'s claim is strictly 1:1 — one bead → one worktree → one
worker spawn → one PR → one gate cycle. When the ready queue is mostly
small, same-area work (observed: 60 of 75 ready beads were P3
review-debt nitpicks), the dominant cost is orchestration overhead, not
the diffs: 60 sequential cold-starts and 60 full gate cycles for what a
single worker could land in one PR.

Cardinality is a scheduling decision, not a constant. The three shapes:

- **solo (1:1)** — risky/cross-cutting work: P1/P2, features, bugs
- **batch (N:1)** — compatible small beads: same affinity, low
  priority → ONE worker, per-bead commits, ONE PR covering all
- **stack (N:N ordered)** — dependent chains — already exists via
  `bro stack` / `--stack`

This bead adds the batch shape. It is NOT a molecule — `bro convoy`
spawns one worker per step, which is exactly the overhead batching
removes.

## Design

### Claim — `push next bead` generalizes to `push next clump`

`loop.batch` (config + `--batch N`, default 1 = today's solo shape)
sets the max clump size. When >1, the claim picks the top ready bead
(the **lead**) and then greedily claims additional queue members
sharing the lead's **affinity key**, up to the cap and the run's
`--max` budget.

Affinity keys are *creation-time* signals, never claim-time guesswork
(the bead's user refinement): a bead's key set is, in precedence order,

1. `spec:<ref>` — a `spec: <path>` mention in the description
   (normalized to the spec id: `specs/` prefix and `.md` suffix
   stripped)
2. `epic:<parent>` — the bead's `parent` (on a claimable bead the
   parent is always an epic — molecule steps are filtered upstream)
3. `area:<label>` — `area:*` labels (debt beads carry these since
   `beadInput` stamps them from the thread's file path)
4. `path:<prefix>` — a path-looking token before the title's first
   colon (`foo.ts:`, `specs/sessions:` — a bare word like `loop:` is
   not a path)

The clump binds on the lead's *single* highest-precedence key; members
must carry that same key in their own key set. Single-key binding —
never transitive expansion — keeps a clump same-concern only.

Batch eligibility (`batchable`): `priority >= loop.batchMinPriority`
(default 3 — P3/P4 only; urgent work always claims solo) and no `solo`
label (the per-bead opt-out). The same bar applies to lead and members:
a P1 lead never batches, and a P1 sibling never joins a P3 clump.

A claim that found no compatible members is just a solo item — the
queue drains in clumps where affinity exists and singletons where it
doesn't.

### Work — one worktree, one worker, per-bead checkpoints

The clump plans on the lead's slug (`loop/<lead>`, or one stack member
under `--stack`) — one worktree, one spawned agent, one PR. The agent
env gains `BRO_BEAD_IDS` (comma-separated, all members; `BRO_BEAD_ID`
stays the lead for compatibility).

`buildWorkPrompt` accepts `LoopBead | LoopBead[]`; an array >1 renders
the batch work order: numbered per-bead sections plus the batch rules —

- **per-bead commits**: each bead is its own commit+push checkpoint,
  its conventional message naming the bead id — the commit IS the
  checkpoint (d6k4v's push-before-verify order, per bead)
- **per-bead verdicts**: a bead needing no change is closed by the
  agent directly (`bd close <id>` / the backend's verb — per id, not
  `$BRO_BEAD_ID`)
- **one PR** whose body lists a `Closes <id>` line per resolved bead
- unfinished beads are left open — the run re-queues them

The gate coverage rule is *evidence-based*: at merge, the loop reads
the member branch's own commit log (`merge-base HEAD <base>..HEAD`)
and closes exactly the clump members named in commit messages. A member
the PR merged without covering is **reopened — the unfinished tail
re-queues**. Fail-safe by construction: a batch that dies mid-way loses
only the in-flight bead, never the landed prefix; a bead the agent
finished but forgot to name in a commit requeues and re-closes as a
cheap verdict, instead of a false "landed" close losing real work.

Solo claims keep the unconditional close — the solo contract never
required bead ids in commit messages.

### Settle — the clump is one gate member

A clump occupies one `loop.maxOpen` slot and rides the same member
lifecycle: fix rounds and rebase rounds respawn into the shared
worktree (prompts name the whole clump), park/close notes fan out to
every still-open member, and the watch marker carries the comma-joined
member ids so `act rearm` discharges every claim a landed batch PR
covers (`closeLandedBead` splits on `,` — solo markers unchanged).

No-PR outcomes generalize per member: all-closed on agent exit is a
`closed` verdict; otherwise every *unclosed* member reopens (verdict
closes stand) — a partial batch loses only the beads that never got a
verdict.

### Scheduling contract preserved

- The run ends on drained queue AND empty stack — a clump's members
  count individually against `--max` (claims, not items).
- `--label` scope still gates who may be claimed at all; clumping only
  picks inside the claimable queue.
- `solo`-labelled beads are never clumped — the operator escape hatch.

## Non-goals

- No judge-scored batchability — labels/parents/spec refs suffice for
  v1; `judge` scoring of "same touched-package" is a follow-up.
- No dep-edge ordering into stacks — `bd dep` chains are stack work,
  not batch; nothing new is needed there.
- No molecule changes — convoy keeps per-step workers by design.
- No claim-time *discovery* of affinity (diff estimation, touched-file
  prediction) — keys are read, not inferred.

## Validation

- `batch.test.ts` (new, `@broject/loop`): affinity-key extraction and
  precedence, eligibility (priority floor, `solo` label), single-key
  clump binding, size cap, uncovered-tail `coveredBeadIds` parsing.
- `loop.test.ts` prompt additions: batch work order renders all beads,
  the per-bead commit/verdict/`Closes` contract, and backend-aware
  close verbs; solo output stays byte-identical.
- `loop.e2e.test.ts`: a 3-bead same-`area:` clump lands via one PR and
  closes all three; a partial batch (agent commits for a subset)
  requeues the uncovered member on merge.
- `npm run build`, `npm run typecheck`, `npm test`, `check:plugins`,
  `check:embedded`.
