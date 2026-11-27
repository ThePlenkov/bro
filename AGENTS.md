# bro — agent's sidekick

`bro` carries review-debt, open-PR review, drill-frame, and lesson-store
mechanics so prompts do not have to. In a repo with `bro.config.json` or
`.beads/`, run `bro review act status` and `bro review act threads` before
declaring done; use `bro review debt collect`/`next`, close drill frames with
`--result`, and probe lessons before re-investigating.
Hooks rehydrate state and stop once for touched dirty work, open claims,
unresolved threads, or drill frames; ambient state is context, not a block.

## Consumer conventions

- Keep changes small; use independently green PR layers for large work.
- Give every static-analysis finding a structural seam; justify only
  pattern-wide config exclusions.
- Write green on first pass: prefer data-driven dispatch and simple functions
  (cognitive complexity ≤15); redesign flagged code, do not game metrics.
- Never hand-edit generated code; run its generator and freshness check.
- Verify with the exact CI command, then inspect the review gate and threads.
- Resolve conflicts by hunk, audit against the target tip, and preserve
  concurrent work.
- Parse JSONC with its parser and edits; manifests and locks are strict JSON.
- Fail loudly on project errors; do not turn outages into empty success.
- Keep global, committed project, and gitignored local config layers separate.
- Render user-facing PR references as links, never bare `#N`.
- Never put secrets in argv or echoed args; one executor owns each work unit.

Developing bro, detailed operations, and implementation notes: see
`CONTRIBUTING.md`.
