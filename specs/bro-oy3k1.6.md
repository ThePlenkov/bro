# bro-oy3k1.6 — fold loop/drive re-entry onto `rig next`

Parent: `bro-oy3k1` (one lifecycle state machine per work item).
Siblings `.2`–`.5` shipped the machinery — frame queues, park/wake,
spawn-owned transitions, and the stateless verdict verb. This child
wires the two policies onto the one ladder.

## Loop — the pick consults the verdict

`claimClump`'s candidate filter currently reads raw status
(`≠ in_progress/closed`). That misses what the engine already knows:
a live registry agent without a re-stamped claim (`wait`), a parked
frame (`wait`), a dep-gated or foreign-claimed row (`blocked`).

Fold: a **lead** candidate is claimable iff `rigNext(root, id,
{store: ctx.tasks}).verdict ∈ {step, gate}`. `step` is obvious;
`gate` stays claimable because the loop owns the *re-attach*
contract — a woken park whose branch already carries an open PR must
be re-claimed so the loop rejoins that gate (merging + closing the
bead), not skipped into an orphaned PR. **Clump members** are stricter
— `step` only: a `gate` member already has its own PR in flight, and
folding it into the lead's clump would re-work a gated branch. What
the fold excludes is `wait`/`blocked`/`done`: parked frames, live
workers, foreign claims, dep-gates — the work another plane owns.
The worktree/gate probe costs a host call only for items that
actually have a worktree (fresh beads skip it by construction). The
probe reads through `ctx.tasks` (the facade-resolved store), so a
non-beads `connectors.tasks` backend answers the same verdicts; a
probe that throws treats the candidate as claimable — racedAway stays
the guard, a blind probe must not mask work.

## Drive — the fixer spawn respects `wait`/`blocked`

`spawnStepAgent`'s registry dedup already refuses a live or foreign
claim — the fold adds what the registry can't see: a fixer bead someone
**parked** (`waiting` label = "a human shelved this fix") must not be
spawned by the next drive pass. Before the spawn: `rigNext` — `step`
or `gate` (the PR is up; that's *why* the fixer exists) proceed,
`wait`/`blocked`/`done` skip with a `spawn-refused`-style verdict.

## Non-goals

- Loop's clump order stays classify/affinity — `rigFocus` order
  applies to the *verdict*, not to re-sorting loop's pick list.
- Drive's discovery stays PR-first — inverting it onto a bead-first
  `rig next` scan is a separate refactor.
- No new verbs, no daemons.

## Verify

- Loop e2e: a candidate carrying a live registry agent or a parked
  label is skipped down the chain to the next claimable.
- Drive e2e/unit: a fixer bead marked `waiting` is refused.
- `npm run build && npm run typecheck && npm test`.
