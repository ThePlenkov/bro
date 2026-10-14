# bro-xkrbk — spec check evidence precedence is declared-over-discovered

## Problem

A bead carrying both an on-disk spec (`<sdd.dir>/<id>.md`) and a `spec:`
link in its description reports verdict `link` from `bro spec check` —
which evidence wins, and whether uncommitted files count, was
undocumented (dogfood df-core-workflow-mv6ldgld-2c9d: the runner wrote
both and could not tell which satisfied the gate).

## Design

`specState` order is the contract:

1. `exempt` — chore / molecule / `trivial` / `debt` are never judged.
2. `link` — a declared `spec:` link is the bead's own statement of
   where its spec lives, so it outranks convention-based discovery.
   `bro spec drift` honors the same rule: the declared target is the
   audited file, never silently substituted by the tree pick. `check`
   counts the declaration itself — it does not resolve the target.
3. `spec` — the serving connector's `hasSpec` discovery.
4. `missing`.

Coverage reads the working tree: an uncommitted spec file counts for
`check` — the spec rides the feature branch, so an uncommitted file is
already evidence. `drift` is freshness, not coverage: it dates only
commits on the ref, so the same uncommitted spec is `unverifiable`
there.

## Plan

- [x] document the order in spec.ts (docstring, specState, usage)
- [x] document it in skills/sdd and site docs
- [x] pin it in spec.test.ts
