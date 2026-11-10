# bro-0i1lm — a landed PR is a verdict, not a failure

## Problem

`bro act wait --merge` is the watcher of record: the `ship-bead` formula's
merge step runs it, and the step closes on its verdict. When another actor
lands the PR first — GitHub's auto-merge (`gh pr merge --auto --squash`),
a human, another session — the watcher's answer is undefined for the
caller.

1. **The wait settles on the merged PR and says nothing about it.** The
   settled wait prints the PR and the gate (`printStatus`), but that
   function prints `mergeable` / `merge_state` / `draft` — never the PR's
   `state`, and never who landed it. The caller sees `exit_gate=OK` and no
   word about the merge. The path is undefined for the caller: the agent
   holding no verdict reads the PR by hand and writes the result itself —
   exactly how a merge step ends up closed on a claim (the failure
   bro-4cxnd fixed on the convoy side).

2. **The race reports a failure.** `cmdMerge` fetches the PR state itself,
   deliberately off the shared cache (a ≤ttl-old green must never land a
   PR). So it can see a merge the wait's last poll never saw — the PR
   landed between the poll and the merge attempt. That path prints
   `error: [#N](url) is MERGED — only OPEN PRs can be merged` and exits
   **1**. The merge the caller asked for happened; the watcher calls it a
   failure.

3. **The actor is lost.** The host knows who landed the PR (GitHub's
   `mergedBy.login`) and the state carries it nowhere. The verdict could
   name the actor — watcher / auto-merge / human — and does not.

## Design

### A landed PR is a verdict

MERGED is the merge goal, satisfied. CLOSED is not — the PR was
abandoned, nothing landed, and no merge can happen.

- `bro act wait --merge` on a merged PR → exit **0**, with a verdict line:
  `act: [#N](url) was already merged by <actor>`.
- `bro act merge` on a merged PR → the same verdict, exit **0**. (Was:
  exit 1, "only OPEN PRs can be merged".)
- `bro act merge` on a **closed** PR → unchanged: the lifecycle error and
  exit 1 — nothing landed, and the caller must know that.

The rule lives in one place: the merge *state* decides, not the merge
*attempt*. A PR that is merged needs no merge.

### The actor comes from the host

`PrActState.mergedBy` carries the host's merge record (GitHub's
`mergedBy.login`), `undefined` when the host cannot say. The verdict
names the actor; a missing actor degrades to "was already merged" — never
a guess, never a blank.

### The verdict event names the landing too

The wait's settle event is the journal a dead watcher leaves behind
(`act wait on [#N](url) settled MERGED by <actor>`). The same actor the
stdout names rides along, so a session that rehydrates later reads who
landed the PR without re-reading it from the host.

### The claim still discharges

The already-merged path keeps what it does today: the loop-claimed bead
closes (`closeBeadIfLanded`) and the closed PR is harvested
(`harvestClosedPr`). Only the verdict and the exit code change — the
landing is a success, not a lifecycle error.

## Contract

| command | PR state | before | after |
| --- | --- | --- | --- |
| `bro act wait --merge` | MERGED | exit 0, no word about the merge | exit 0, `act: [#N](url) was already merged by <actor>` |
| `bro act merge` | MERGED | exit 1, "only OPEN PRs can be merged" | exit 0, the same verdict |
| `bro act merge` | CLOSED | exit 1, "only OPEN PRs can be merged" | unchanged |

## Tests

- `act wait --merge` on a merged PR → exit 0; stdout carries the link and
  the actor; the settle event names the actor.
- `act merge` on a merged PR → exit 0 and the same verdict (the old test
  pinned exit 1 — it moves with the contract).
- `act merge` on a closed PR → still exit 1 with the lifecycle error.
- A host that cannot name the actor → the verdict degrades to "was already
  merged", without a name.

## Out of scope

- **Branch cleanup on the already-merged path.** `--cleanup` deletes the
  landed branch; running it for a PR somebody else landed risks a branch
  another session owns. The already-merged path keeps today's behaviour:
  discharge the claim, harvest, report. Cleanup stays the operator's call.
- **The merge-step verification** (the convoy side: a merge step closes on
  a host verdict, not on the agent's sentence) — that is bro-4cxnd, a
  separate change.
