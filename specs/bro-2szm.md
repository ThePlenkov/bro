# bro-2szm — stepKind classifies by title regex, not declared type — 'GATE'/'Merge' titles silently turned agent steps human

## Problem

`stepKind` in `packages/convoy/src/molecule.ts` falls back to a title
regex (`/\b(human\s+gate|gate)\b/i`) when `issue_type` isn't `agent`/`human`.
That made every agent step whose title merely *mentions* a gate — ship-bead's
"GATE — …" steps, "Merge … gate" steps — classify as `human`, parking the
convoy on a human that never comes. Titles were renamed in protos and poured
mols as a stopgap; the classifier still mis-reads display text as scheduling
semantics.

## Design

Declared type is the contract; the title is display-only:

- `issue_type: "human"` → `human` — bro's declared human-step convention.
- `issue_type: "gate"` → `human` — bd's native gate: a poured
  `[steps.gate]` block materializes as a separate `gate`-typed issue that
  blocks its step. It is a wait condition, not agent work — an agent that
  could `done` it would self-approve human gates.
- everything else (`agent`, `task` incl. flattened legacy types, `bug`,
  …) → `agent`.

Steps flattened to `task` by a pour that ran before `types.custom`
registered `agent`/`human` are agent-executable — the declaration is
unrecoverable post-flatten; `bro convoy pour` registering the types up
front is the protection, not a title guess.

## Plan

- [x] `stepKind`: drop the title regex; `human`|`gate` → `human`, else `agent`
- [x] `formulaSteps`: any `[steps.gate]` block → `gate` — pre-pour
      classification matches post-pour `stepKind` (bd materializes a
      `gate`-typed issue whatever the gate's condition type)
- [x] update doc comments (`molecule.ts`, `plan.ts` type field note)
- [x] tests: declared-type classification incl. `gate` type; `GATE —`-titled
      task stays `agent`; nextStep gate-state fixture uses `issue_type: human`
