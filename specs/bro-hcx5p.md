---
scope:
  - packages/core/src/tasks.ts
  - packages/core/src/connectors.ts
  - packages/core/src/index.ts
  - packages/cli/src/commands/next.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/spec.ts
  - packages/cli/src/commands/act.ts
  - packages/cli/src/commands/testrepo.ts
  - packages/convoy/src/molecule.ts
  - packages/learn/src/connector.ts
---

# bro-hcx5p — batch serial bd-show storms through the widened TaskStore port

## Problem

bro-i2mzv measured where bd latency goes: the managed dolt server
killed the ~3s/call floor; what remains is ~0.65s of `bd` binary init
**per spawn** — irreducible while bd is a CLI. The only lever left is
call count, and several paths still pay one `bd show` per id:

- `epicParentIds` (next.ts) — one `bd show` per unique parent, every
  `bro next`/`bro loop` pick. The process-local cache dedupes *within*
  a run; each run re-pays the full set.
- `openBeads` (loop.ts) — one show per clump member, probed
  repeatedly per member action (settle/verdict paths call it twice
  over the same members).
- `bro spec check|drift id…` — serial `get` per positional id.
- `stepInputs` (convoy/molecule.ts) — one show per closed blocker.
- `closeLandedBead` (act.ts) — one store resolution + one show per
  clump id on every merge discharge.
- `sessionContextText` (learn/connector.ts) — `Promise.all` of per-id
  `get`s: N overlapping spawns that still cost N binary inits.

`bd show [id…]` already batches natively: a partial miss omits the
missing rows and exits 0; a total miss exits 0 with an
`{error: "no issues found matching the provided IDs"}` envelope on
stdout. The widened TaskStore port (bro-thzm7) has no verb for it —
callers can only reach it one id at a time.

## Design

### Port: `getMany` — an optional bulk read

```ts
/** rows for `ids` — one backend call where the backend batches
 *  (beads: `bd show id…`). Missing ids are absent from the result —
 *  the same miss semantics as `get`, per id; ordering is the
 *  backend's, callers that need request order re-key by `id`.
 *  Optional capability — a backend that can't batch omits it and
 *  callers degrade to serial `get` via getTasks. */
getMany?<T extends TaskRow = TaskRow>(ids: string[]): T[]
```

- `TaskStoreAsync` mirrors it. The sync→async adapter in
  connectors.ts exposes `getMany` only when the wrapped store has it —
  a faked serial `getMany` would hide the capability from the very
  degrade decision it exists to inform.
- beads: `bd show id…` once; the `{error}` total-miss envelope folds
  to `[]`, an array folds through `taskRows` — any other non-array
  shape is `BdCompatError` drift. Empty `ids` short-circuits without
  a spawn (bare `bd show` answers a usage-error envelope, not rows).
- github/linear: **omit** — neither connector has a true batch read
  today (aliased GraphQL queries are a later bead). Absence is honest;
  the degrade path is the same spawn/API shape they'd hand-roll.

### Degrade helpers — `getTasks` / `getTasksAsync`

```ts
getTasks<T>(store: TaskStore, ids: string[]): T[]
getTasksAsync<T>(store: TaskStoreAsync, ids: string[]): Promise<T[]>
```

Exported from core so callers never hand-roll the fallback — the
async degrade overlaps `get`s (`Promise.all`), the sync degrade is a
serial map. Neither swallows backend failures: miss semantics cover
absent ids, a dead store still throws.

### Conversions

- **next.ts `epicParentIds`** — cached positives still skip; every
  uncached parent goes in ONE `getTasks` call, results feed the
  positive-only cache exactly as before.
- **loop.ts `openBeads`** — one `getTasks` for the clump; only rows
  positively `closed` filter out (a missing row or a thrown read
  reads as still-open — the old per-member 'unknown' contract).
- **spec.ts check/drift** — positional ids resolve through one
  `getTasks`, re-keyed by `id` to preserve request order and the
  unknown-ids usage error.
- **molecule.ts `stepInputs`** — one `getTasks` for the closed
  blockers, re-keyed for titles/close_reasons.
- **act.ts `closeLandedBead`** — the clump's rows fetched once up
  front; a failed batch leaves `rows` undefined and each member's own
  probe reports the dead store exactly as today.
- **learn connector `sessionContextText`** — `getTasksAsync` replaces
  `Promise.all`-of-gets: one spawn on beads instead of N.

### testrepo fake bd

`show` learns multi-id semantics: found rows in one array, missing
ids warn on stderr, a total multi miss answers the `{error}` envelope
(exit 0), a single miss still exits 1 — so converted call sites
behave identically under the fake and the real binary.

## Test plan

- `npm run build`, `npm run typecheck`, `npm test` (the CI trio).
- New core tests: `getMany` issues one `bd show` for N ids, folds
  partial misses, folds the total-miss `{error}` envelope to `[]`,
  short-circuits on empty input; `getTasks` degrades to serial `get`
  on a store without the capability.
- Focused runs: tasks.test.ts, next/loop/spec e2e under the testrepo
  fake.
