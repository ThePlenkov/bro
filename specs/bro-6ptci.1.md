---
scope:
  - packages/cli/schemas/cli/watchdog.schema.json
  - packages/cli/schemas/cli/debt-status.schema.json
  - packages/cli/src/plugins.ts
  - packages/cli/src/commands/contract.test.ts
  - contract/cli.json
---

# bro-6ptci.1 — contract: --json schema-ref integrity — watchdog schema missing + refs unchecked

Parent epic: bro-6ptci (CLI is the agent contract).

## Problem

`packages/cli/src/plugins.ts` declares `json: 'schemas/cli/watchdog.json'`
for `bro watchdog --json` (added by PR #882) and `contract/cli.json`
carries the same ref — but no such file exists.
`packages/cli/schemas/cli/` holds exactly 10 `*.schema.json` files,
none named `watchdog`. The ref is both dangling AND misnamed: every
other ref uses the `.schema.json` suffix. Nothing validates that
`json` refs resolve — `check:contract` only diffs registry→cli.json,
never touches the filesystem, so the rot shipped silently.

Same-directory drift: `debt-status.schema.json` exists but is
referenced nowhere — a phantom, since `cmdStatus` (debt.ts) is
text-only and `debt status` has no `--json` flag at all.

## Design

### 1. `packages/cli/schemas/cli/watchdog.schema.json` (new)

Faithful to the emit site `JSON.stringify({ ts, skill, baselines })`
at `watchdog.ts` (`runWatchdogCommand`), types at
`watchdog.ts:120-186`. Shape:

- top-level object, `additionalProperties: false`, required
  `[ts, skill, baselines]`:
  - `ts`: string — ISO-8601 (`new Date(now).toISOString()` minus ms)
  - `skill`: string — `WATCHDOG_SKILL` = `'watchdog'`
  - `baselines`: `$ref` → `WatchdogBaselines`
- `WatchdogBaselines`: object, `additionalProperties: false`,
  required all 10 planes `[ts, unit, daemon, loopOut, prs, disk,
  memory, worktrees, slots, residue]`:
  - `ts`: string (the tick clock, duplicated at top level)
  - `unit`, `daemon`, `loopOut`, `prs`, `disk`, `memory`,
    `worktrees`: each `oneOf` [typed object, `Unavailable`]
  - `slots`: `oneOf` [array of `WatchdogSlot`, `Unavailable`]
  - `residue`: `oneOf` [integer, `Unavailable`]
- `Unavailable`: `{type: object, required: [unavailable],
  properties: {unavailable: {type: string}},
  additionalProperties: false}`
- Plane object types mirror the TS interfaces exactly:
  - `WatchdogUnit {state: string, mainPid: int|null, nRestarts:
    int|null}`
  - `WatchdogDaemon {pid: int|null, alive: bool|null, logAgeSec:
    int|null, etimedout: int|null}`
  - `WatchdogLog {lines: int, ageSec: int|null, etimedout: int|null}`
  - `WatchdogPrs {open: int, ours: int, foreign: int, capped: bool}`
  - `WatchdogDisk {path: string, usePercent: number}`
  - `WatchdogMemory {swapUsedBytes: number, memAvailableBytes:
    number}`
  - `WatchdogWorktrees {count: int}`
  - `WatchdogSlot {slug: string, beadId: string, pid: int|null,
    state: enum[running, dead], silentMs: number|null}`
- Every plane/slot object is `additionalProperties: false` — the
  emit is closed-world (explicit field mapping at the slots site,
  fixed literals elsewhere), so a field rename SHOULD fail validation
  once bro-6ptci.2 wires output-vs-schema checks.
- `$id`: `https://broject.dev/schemas/cli/watchdog.schema.json`
  (matches the existing files' convention).

### 2. Ref fix + regen

`plugins.ts` watchdog `contract.json`:
`'schemas/cli/watchdog.json'` → `'schemas/cli/watchdog.schema.json'`.
Then `npm run gen:contract` rewrites `contract/cli.json`.

### 3. Ref-existence test — `contract.test.ts`

New `describe('json schema refs')` (or sibling test file section):
collect EVERY `json` string reachable in `buildDump(PLUGINS,
GROUP_META)` — `commands.*.contract.json` plus every
`commands.*.contract.subs.*.json` — resolve each against
`packages/cli/`, assert the file exists. Implemented as a small
pure helper `missingSchemaRefs(dump, pkgDir)` returning the sorted
list of unresolvable refs so the failure message names them.

Proof it bites (both directions, per the bead's verify list):

- live registry: `missingSchemaRefs(buildDump(PLUGINS, GROUP_META),
  <packages/cli>)` is `[]`.
- synthetic dump: a `fakePlugin` whose contract carries
  `json: 'schemas/cli/does-not-exist.schema.json'` (top-level and a
  sub) is reported — same code path, so a deleted/renamed schema
  file fails CI exactly like the watchdog rot would have.

### 4. Phantom cleanup — delete `debt-status.schema.json`

Unreferenced AND wrong (describes a `--json` output that does not
exist). Removing beats repurposing: `bro-6ptci.2` owns the decision
to schema the REAL debt `--json` outputs (`stats`, `trend`); if it
ships one it adds a correctly-named file then. No `--json` flag is
added here — that is a feature, out of scope.

### 5. Stub schemas — deferred

`debt-next`, `fleet-status` (and the deleted `debt-status`) are
`additionalProperties: true` 7-liners that cannot catch renames.
Fleshing them out is explicitly `bro-6ptci.2` gap 1 — noted there,
not duplicated here.

## Non-goals

- No output-vs-schema validation (needs a validator dep — 6ptci.2).
- No new `--json` flags, no stub tightening, no contract-shape
  changes beyond the one ref string.
- `check:contract` stays a pure doc diff; the fs check lives in the
  test suite (tsx --test), which is where `npm test` runs it.

## Acceptance

- `schemas/cli/watchdog.schema.json` exists, validates the real
  `--json` emit shape (10 planes, typed-or-unavailable, slots items
  `{slug, beadId, pid, state, silentMs}`).
- `contract/cli.json` carries `schemas/cli/watchdog.schema.json`;
  `npm run check:contract` green.
- The ref-existence test fails on a dangling ref (proven by the
  synthetic-dump case) and passes on the live registry.
- `debt-status.schema.json` gone; `git grep debt-status` clean.
