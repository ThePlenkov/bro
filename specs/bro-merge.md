# bro-merge — `bro merge <PR>`: the full merge cycle as one verb

## Problem

Landing a PR today is five commands and a memory: `gh pr ready`, `bro act
status`, fix, `bro act wait --merge`, `bro self retrospect record`. Each
step exists — the exit gate is code, the wait is code, the retro store is
code — but no verb owns the cycle, so every session re-derives the order
and forgets one of the legs (usually the retro, sometimes the ready).

`bro drive` supervises *orphaned* PRs across the fleet; `bro act` is the
gate and the low-level steps. Nothing composes the lifecycle for the PR
the calling session itself is driving.

## What `bro merge` is — and is not

One supervised sequence over the PR the caller points at. It composes the
existing verbs; it does not re-implement them:

```text
bro merge <PR> [--strategy squash|merge|rebase] [--bead ID] [--no-retro]
               [--interval S] [--timeout M] [--json]
```

1. **ready** — `state.isDraft` → mark-ready on the host. Already open →
   no-op. Hosts without a ready call fail loud with their own error.
2. **gate** — the `act wait` loop verbatim: same fetch
   (`fetchPrActState`), same exit gate (`evaluateExitGate`), same
   update-branch step, same webhook wake. The loop settles when nothing
   is pending — green, or a settled blocker (threads, failing CI, SAST,
   conflict, CHANGES_REQUESTED).
3. **settled blocker → report and exit 1.** `bro merge` supervises; it
   does not write fixes — the calling agent (or a fixer) owns
   remediation. The command is re-entrant: every finished phase is a
   no-op on re-run, so `bro merge` after fixing resumes, never restarts.
4. **green → automerge.** `enableAutoMerge` on the host for the strategy
   given. Hosts without auto-merge fall back to the pinned direct merge
   (`mergePr` with `expectedHeadSha` — the sha the gate evaluated, never
   a newer head) with a warn line.
5. **settle** — the same poll loop runs until MERGED, CLOSED, or
   `--timeout`. `--detach` is deferred: `act wait --merge --detach`
   already covers the backgroundable shape; merge gains detach when a
   real need appears.
6. **retro** — on MERGED, the cycle's evidence becomes a
   `retrospect record`: resolved thread titles, blockers observed during
   the run, fix rounds, elapsed time, plus one `sink: backlog` action
   telling a follow-up to classify findings into prevention work.
   `--no-retro` skips; a retro write failure warns, never un-merges.
7. **bead** — `--bead` closes the claimed bead on MERGED, same twin rule
   as `act wait --merge` (MERGED closes, CLOSED-unmerged keeps).

## Out of scope (v1)

- **Spawning fixers.** Drive owns respawn semantics (occupancy, walls,
  bead dedup). `bro merge` reporting a blocker is the hook a drive pass
  or the calling agent reacts to.
- **Review triggering.** Devin Review / host review request is
  host-side automation, not part of this verb.
- **Stack semantics.** `bro flow stack merge` owns the stacked landing
  order; `bro merge` is per-PR.

## Non-negotiables

- **The gate is the merge precondition.** Every merge path — automerge
  or pinned fallback — lands only after `evaluateExitGate` returns
  `blockers: []` on the head being merged. A head that moved since the
  gate ran fails closed (`expectedHeadSha`), same as `landPr`.
- **Human-owned PRs warn, not block** — `prOwnership`, same as `act`.
- **Idempotent phases.** Re-running `bro merge` on a ready, green, or
  already-merging PR must not repeat a side effect.
- **Host calls fail loud** — the host's own error text reaches stderr;
  no silent fallbacks except the documented automerge→pinned-merge one.
- **Infra failures don't block** — an unreachable retro store, a failed
  marker write, or a dead wake source warn and continue; the merge
  verdict is the contract.
