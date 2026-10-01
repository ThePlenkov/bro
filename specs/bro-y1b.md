---
parent: backends
---

# bro-y1b — bd compatibility check + graceful degradation

## Problem

`bd` (beads) is the default task store, but beads is pre-1.0 and moves
fast (Dolt-backed). A bd release can rename a subcommand, drop a flag, or
change a `--json` payload shape — and bro finds out as a mid-command
crash: `bd returned malformed JSON`, `unknown flag`, or a wrong-shaped
result surfacing as a `TypeError` deep in `debt collect`. The ledger's
jsonl evidence is already durable at that point; the failure is the
*projection* dying, yet it exits the whole run at 1.

## Design

### Contract probe — `probeBdCompat(dir)` in `@broject/core`

Version numbers can't pin a pre-1.0 contract, so the probe verifies what
bro actually calls:

- `bd --version` — presence (`missing` on ENOENT) + parsed version.
- `bd list --json -n 1` / `bd ready --json -n 1` — the read-path
  contract every TaskStore consumer builds on. Exit 0 ⇒ output must be a
  JSON array of rows with a string `id`; anything else is drift.
  `no beads database` on stderr ⇒ store absent, not drift (shape probes
  are inconclusive without a store). Usage-class errors (`unknown
  command`, `unknown flag`, `flag provided but not defined`) ⇒ drift.
- `bd info --json` (store reachable) — `schema_version` newer than the
  schema this bro knows ⇒ drift.

Result: `{ ok, missing, version?, problems[], store, storeErr? }`.

### Drift classification — `BdCompatError` + `isBdCompatError(err)`

`BdCompatError` marks "this bd can't speak the contract" — thrown by the
probe gate and by TaskStore shape validation. `isBdCompatError` also
matches raw spawn failures whose stderr/message carries usage-drift
patterns (`unknown command|flag`, `flag provided but not defined`,
`malformed JSON`), so drift on write paths (`create`, `update --claim`,
`init --stealth`) classifies too.

### TaskStore shape validation

`taskStore()` readers (`list`, `ready`, `get`, `children`, `deps`) and
`create` validate the parsed payload is the row/array shape the contract
declares — a well-formed-JSON-but-wrong-shape response is drift, not a
`TypeError` downstream.

### Gates

- `checkBeads` (core + debt): after the presence probe, drift ⇒
  `BdCompatError`. Task commands (`drill`, `next`, `loop`, `debt sync`)
  still fail on drift — beads *is* their store; there is no fallback —
  but they fail fast with a named cause instead of crashing mid-run.
- `bro doctor`: new `bd-compat` check in the bd group. `ok` when the
  contract verifies (detail notes when the store probe was inconclusive);
  `fail` when drift is found and `beads` is an active store, `warn`
  otherwise.

### Graceful degrade — `bro debt collect`

A `syncDebtToBeads` failure that classifies as compat/drift warns and
continues: the ledger stays jsonl-only (already durable), collect exits
0, and the hint says fix bd or opt out with `"stores": ["jsonl"]`.
Non-compat sync failures keep today's behavior (`debt sync FAILED`, exit
1, retry hint) — a transient or store-level failure is not drift.

## Plan

- [ ] core `bd.ts`: `BdCompatError`, `isBdCompatError`, `probeBdCompat`;
      `checkBeads` gains the compat gate
- [ ] core `tasks.ts`: row/array shape validation → `BdCompatError`
- [ ] debt `beads.ts`: `checkBeads` uses the probe (auto-init ordering
      preserved: init before the store-dependent probes when needed)
- [ ] cli `doctor.ts`: `bd-compat` check
- [ ] cli `debt.ts`: collect degrades on `isBdCompatError`
- [ ] tests: compat probe + doctor shims + taskStore shape violations
