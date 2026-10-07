# bro-wlal — ship-bead: draft iff merge=human — ready PRs for automerge flows

## Problem

bro convention opens every PR as a draft (AGENTS.md "opened as a draft PR").
For ship-bead `merge=auto` (the convoy default) the draft blocks
`bro act wait --merge` until a human marks ready — a wasted pipeline cycle
plus a human click on a flow designed to be autonomous. Seen live: sverka
PR #316's watcher sat blocked on `draft=true`.

## Design

The draft flag becomes the human gate expressed in GitHub terms:

- `merge=auto` → `gh pr create` (ready). The act gate + watcher are the
  merge mechanism.
- `merge=human` → `gh pr create --draft`. Marking ready IS the human gate
  event.
- Optional `--var draft=auto|true|false` on ship-bead (default `auto` =
  derive from `merge`) for "automerge but eyes first" cases.

Change surface (small — docs/formula only):

- `formulas/ship-bead.formula.toml` — add `vars.draft`; work step states
  the draft policy per the merge/draft vars.
- `AGENTS.md` ~L70 — replace "opened as a draft PR" with merge-target
  semantics.
- `skills/next/SKILL.md` flow line — note the policy.
- exit-gate already blocks drafts ("PR is a draft") — consistent, no code
  change; `bro act merge` refusing drafts is correct for `merge=human`.

## Plan

- [ ] Write spec (this file)
- [ ] `ship-bead.formula.toml`: `vars.draft` + work-step draft policy
- [ ] `AGENTS.md`: draft flag mirrors merge target
- [ ] `skills/next/SKILL.md`: note the policy in the flow line
- [ ] `npm test` (exact CI command), commit, push, ready PR
