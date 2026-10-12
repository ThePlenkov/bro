# bro-c650l — PR ownership marking: bro-managed label + body trailer

## Problem

An operator with several open PRs can't tell at a glance which ones bro
drives to merge (gate stack → `act merge`) and which ones are theirs to
land by hand. Loop PRs today carry only reviewer-noise labels
(`size:*`, `baz:*`), so `gh pr list -l bro-managed` returns nothing and
`bro watch` rows read identically for bro-owned and human-owned PRs.
Worse: a convoy `merge=human` worker opens a draft — bro's PR, the
human's merge — and nothing on the PR says so.

## Design

Two mutually exclusive labels name who lands the PR:

- **`bro-managed`** — a bro plane (the loop's gate stack, `bro drive`)
  drives the gate to merge.
- **`bro-review`** — bro opened the PR but a human merges: the
  `merge=human`/draft contract (the draft flag IS that contract — the
  exit gate never merges a draft).

Absence of both = human-owned — `bro act merge` warns before landing
one (advisory, never a blocker).

**Stamp at discovery, not creation.** `pushItem→findPr` is the single
chokepoint every loop PR crosses — the stamp lands there, not in the
worker's `gh pr create` flags. The loop stamps `bro-managed`
(`bro-review` when the discovered PR is a draft) with a warn-only
failure path. `bro drive` stamps what the loop can't reach: a draft on
a supervised branch → `bro-review`; an orphaned, non-draft PR under a
merging drive → `bro-managed`. Occupied PRs (a live session owns the
worktree) are left alone — the owning plane stamps at its own
discovery, and `--no-merge` drives supervise without claiming the
merge.

The stamp is **best-effort**: a host without labels/body access skips
that half; a failed write warns and never fails the discovery or the
pass.

**Body trailer.** The stamp merges `{managed, bead?, mode, run}` into
the PR body's `<!-- bro: {...} -->` comment — the same trailer
convention task bodies already carry (`taskmeta.ts`), so attribution
reads (`bro-fatja`, the lifecycle log) parse one shape across issues
and PRs. `mode` is the stamping plane (`loop`/`drive`), `run` the
run's branch identity, `bead` the claimed clump's ids (loop only —
drive doesn't know them). Existing trailer keys survive the merge.

**Facade surface.** `ReviewFacade` gains an optional pair
`prBody`/`updatePrBody` — the trailer rides the body, and a host
without body access simply skips it (labels alone still mark
ownership). Label ops (`labels`/`createLabel`/`addLabel`/
`removeLabel`) already exist on both connectors; `stampPrOwnership` in
`@broject/core` drives them, creates missing labels idempotently, and
removes the opposite label so the two signals stay exclusive.
GitLab maps the same label names onto MR labels — no pre-creation
needed beyond the existing idempotent path.

**Read side.** `bro watch` gate rows and `bro status --deep`'s act row
gain the ownership marker (`· bro-managed` / `· bro-review` /
`· human`), derived from the PR's labels — the same read the operator
does manually with `gh pr list -l bro-managed`.

## Non-goals

- No stamping inside worker prompts or `gh pr create` wrappers —
  discovery is the chokepoint, creation flags stay the worker's choice.
- No retroactive sweep of pre-existing PRs beyond what `bro drive`'s
  ordinary supervision pass already discovers.
- Occupied-PR ownership inference — a live session's PR keeps
  whatever stamp its own plane landed (or none).
- Blocking `act merge` on unlabeled PRs — the warning is advisory;
  an unstamped bro PR (label write failed) must never become
  unmergeable.

## Validation

- `npm run build`, `npm run typecheck`, `npm test`,
  `npm run check:plugins`, `npm run check:embedded`.
- Core unit tests: ownership derivation, label exclusivity, trailer
  merge preserving body text + prior keys, best-effort skips on a
  failing host.
- e2e (fake host): a landed loop PR carries `bro-managed` + the
  trailer; a draft under drive gets `bro-review`; an orphaned
  supervised PR gets `bro-managed`; `act merge` warns on an
  unlabeled PR and still merges.
