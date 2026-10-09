---
parent: bro-huy5o
scope:
  - packages/core/src/review.ts
  - packages/core/src/connectors.ts
  - packages/core/src/config.ts
  - packages/core/src/index.ts
  - packages/github/src/reviews.ts
  - packages/github/src/merge-queue.ts
  - packages/github/src/index.ts
  - packages/cli/src/commands/act.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/plugins.ts
  - skills/act/SKILL.md
  - site/content/docs/commands/act.md
---

# bro-huy5o.6 — act merge: merge queue for every PR + external queues

Parent: `bro-huy5o` (epic — adoption-first connector backlog).
Predecessor: `bro-h07vx` (merge-async with `merge_action=merge_queue`,
stack path only).

## Problem

GitHub merge-queue support exists but only fires on the **stack** path:
`mergePr` asks `queueRequired` inside `mergeAsync`, which runs only when
the PR carries `.stack`. A plain (unstacked) PR on a base branch that
requires the merge queue still goes through `gh pr merge` — the doomed
call GitHub refuses — so `bro act merge`, `bro act wait --merge`, and
`bro drive`'s green-PR pass all fail there instead of enqueueing.

Second hole: when a merge IS accepted into a queue, `act merge` exits 0
with the PR still `OPEN` — but `bro drive`'s `mergeAndRetire` reports
that state as `merge-unverified`, a failure-flavored verdict, when it is
a parked PR the queue still owns.

Third: repos whose merge queue is an **external** system — Mergify,
Graphite — have no connector at all; the beads merge slot serializes
local sessions but does not order the merge on the host side, which is
what a queue is for.

## Design

Two mechanisms, one seam each:

| Queue | Selection | Mechanism |
| ----- | --------- | --------- |
| GitHub native | detected on the PR's base — no config | `merge-async` + `merge_action=merge_queue` |
| External | `connectors.mergeQueue = "mergify"\|"graphite"` — name-only, opt-in | the connector's `mergeQueue` facade `enqueue` |

### `mergeQueue` facade (core)

```ts
export interface EnqueueOpts {
  /** Checkout holding the PR head — checkout-bound queue CLIs (gt)
   *  merge from the worktree, not the API. */
  dir?: string
  /** The PR's head branch — the connector verifies the checkout is on
   *  it before running anything that merges "the current stack". */
  headRef?: string
  /** The sha the gate evaluated — a head that moved since must refuse
   *  the signal rather than queue a commit the gate never saw. */
  expectedHeadSha?: string
}
export interface MergeQueueFacade {
  /** Park the PR on the connector's queue. Returns 'merged' when the
   *  call landed the PR outright (a queue-less repo merges directly) —
   *  the honest answer, never a guess. Throws on refusal. */
  enqueue(t: PrTarget, opts?: EnqueueOpts): 'enqueued' | 'merged'
}
```

`mergeQueueHost(dir, prefer)` resolves it — `null` when
`connectors.mergeQueue` is unset (opt-in by name, never auto-detected);
a configured-but-wrong name throws the resolver's error. `FacadeMap`
gains `mergeQueue`; `Connector` gains the optional member.

### act merge dispatch (landPr)

The external queue is consulted inside `cmdMerge`'s critical section,
after the gate passes, before `rev.mergePr`:

- configured → `queue.enqueue(t, { dir: cwd, headRef, expectedHeadSha })`
  — the same pin `mergePr` carries, so a post-gate push can't ride the
  queue signal:
  `'enqueued'` → report "enqueued via <connector>", return undefined
  (no cleanup — the queue merges later);
  `'merged'` → report merged, return head for the normal cleanup.
- unconfigured → `rev.mergePr` (which carries the native-queue routing).

`cmdMerge` also runs `facadeAuth('mergeQueue')` when one is configured —
a missing `gt`/`gh` fails the merge fast with the remediation line,
not a spawn error mid-enqueue.

### GitHub mergePr: queue on the non-stack path

`stackProbe` already reads `base.ref` for every PR — the routing now
uses it for both branches:

```ts
const probe = stackProbe(t)
const queued = probe.base !== undefined && queueRequired(t.repo, probe.base)
if (probe.stacked || queued) → mergeAsync
```

`mergeAsync` takes a route object `{ base?, stacked?, queued? }` instead
of a bare `base` — the caller's precomputed `queued` skips a second
GraphQL probe, `base` still feeds it when absent (the reactive fallback
after a failed probe read).

The reactive net widens from `/asynchronous merge/` to
`/asynchronous merge|merge queue/i` — a sync-merge refusal that names
the queue (a queue toggled on between probe and merge, an API shape the
probe misread) forces `queued`, an async-only refusal keeps probing.

`--delete-branch` never rides the queue path (unchanged contract: the
async endpoint has no such param, and deleting the head of a queued PR
closes it). `postMergeState` re-reads the truth — `OPEN` after
`enqueued` is the honest state.

### drive: enqueued is parked, not failed

`mergeAndRetire` — `act merge` exits 0 only on a merge it saw land or a
queue acceptance (every refusal sets exit 1), so a re-probe showing
`OPEN` after a clean exit IS the enqueue contract:

- `after.state === 'OPEN'` → verdict `enqueued` — parked: fixer bead
  stays open, worktree stays, next pass re-attempts (merge-async's 409
  resumes the same uuid; external enqueues are idempotent).
- anything else non-MERGED → `merge-unverified` (unchanged).

`bro loop` already parks on non-MERGED post-merge state — no change.

### External connectors (packages/github — both ride GitHub PRs)

- **mergify** (`optIn`, `auth` = `gh auth status`): `enqueue` applies
  `act.mergeQueue.label` when configured (`gh pr edit --add-label`) and
  posts the queue command (`gh pr comment --body`, default
  `@mergifyio queue`, `act.mergeQueue.comment` overrides; setting a
  label without a comment posts only the label — Mergify dedups a
  double signal, an unconfigured command is just noise). Both knobs are
  optional; the comment is the zero-config default. The pre-signal state
  read also carries `headRefOid` — an `expectedHeadSha` mismatch refuses
  (the signal targets whatever head the PR now has).
- **graphite** (`optIn`, `auth` = `gt --version`): `enqueue` requires
  `opts.dir` on `opts.headRef` — `gt merge` merges the checked-out
  stack, so a wrong checkout enqueues the wrong stack; verified via
  `git branch --show-current`, mismatch throws. `expectedHeadSha` pins
  twice: the checkout's `HEAD` (the stack `gt merge` sees) and the
  remote `headRefOid` (the PR Graphite would actually land). After
  `gt merge` it re-reads the PR state (`gh pr view --json state`) —
  `MERGED` → 'merged' (a queue-less repo merges directly), else
  'enqueued'.

Config: `act.mergeQueue = { label?, comment? }` — merge policy lives in
the act section.

## Plan

- [ ] `specs/bro-huy5o.6.md` — this spec
- [ ] `packages/core` — `MergeQueueFacade`/`EnqueueOpts`, `mergeQueue`
      on `FacadeMap` + `Connector`, `mergeQueueHost` resolver,
      `act.mergeQueue` config section
- [ ] `packages/github` — `mergePr` queue routing on the non-stack
      path, `mergeAsync` route object, widened reactive net; `mergify`
      + `graphite` connectors
- [ ] `packages/cli` — `landPr` external-queue dispatch + `facadeAuth`
      gate in `cmdMerge`; `mergeAndRetire` `enqueued` verdict;
      connector registration in `plugins.ts`
- [ ] tests — github queue routing (non-stack queued, reactive
      "merge queue" refusal, no double probe), mergify comment/label,
      graphite branch check + post-state, drive `enqueued` verdict
- [ ] docs — `skills/act/SKILL.md`, `site/content/docs/commands/act.md`

## Out of scope

- Dequeue/remove-from-queue — the queue and the host own the PR once
  parked; `bro act merge` never reaches back in.
- `gt submit`/stack creation — the connector only merges an existing
  stack's PR.
- Mergify rule authoring — `act.mergeQueue.label` assumes the user's
  `.mergify.yml` already queues on it.
- `queued()` membership probing on the facade — the exit-0+OPEN
  contract covers the parked verdict; a positive probe can join later
  if a caller needs it.
