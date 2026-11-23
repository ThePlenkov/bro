---
scope:
  - packages/cli/schemas/cli/
  - packages/cli/src/plugins.ts
  - packages/cli/src/commands/contract-schema.test.ts
  - contract/cli.json
---

# bro-6ptci.3 — contract: schema coverage for the deferred agent-facing reads

Parent epic: bro-6ptci (CLI is the agent contract). Follow-up to
bro-6ptci.2, whose §4 audit classified every `--json` emitter and
deferred the five agent-facing reads that had no contract block at all
("adding contract blocks wholesale is a bigger surface change than this
audit"). This bead is that follow-up.

## Problem

Four agent-facing JSON reads still emit shapes a machine consumer parses
with **no closed-world schema and no contract block** — a field rename
or removal ships green:

| Command | Emits | Today |
| --- | --- | --- |
| `bro convoy next` | `ConvoyNext` — `{mol,state,ready,step?,gates,inProgress,inputs?,blocked,stuck}` | always-JSON emit (no `--json` flag exists — `--json` is rejected as an unknown option), no contract block |
| `bro wait <ref> --json` | `{verdict, refs, unsettled?}` — the exit code IS the verdict | no contract block |
| `bro mesh wait <thread> --json` | `{thread, stage?, turn?, envelopes}` | mesh plugin has no contract block |
| `bro mesh inbox --json` | `[{peer, bead, …envelope, mismatch?, unbound?}]` | same |

A fifth, `bro sessions resume`, was deferred sight-unseen: it takes
`--print|--last|--pick` under `positionals(strict)` and **has no
`--json`** — it gets a contract block for its flags/exits but stays out
of schema coverage by deliberate exclusion (below).

## Design

### 1. Schemas — one per emit surface, Draft 2020-12, closed worlds

All four schemas are `additionalProperties:false` at every level the
emitter controls, matching the §2/§4 fleshed-out set.

| Schema | Shape |
| --- | --- |
| `convoy-next.schema.json` | Closed object. Required `mol,state,ready,gates,inProgress,blocked,stuck`; optional `step,inputs`. `state` enum `step\|gate\|blocked\|complete`. `ready`/`step` items: closed `ConvoyStep` (`id,title,description,type,kind,state,blockedBy` all required; `kind` enum `agent\|human`; `state` enum `done\|ready\|blocked\|in_progress`). `inputs` items: closed `{id,title,reason}`. |
| `wait.schema.json` | Closed object. Required `verdict,refs`. `verdict` enum `free\|actionable\|unresolved\|unreadable\|timeout`. `refs`: record arg → closed refEntry `{verdict,source,reason?,stage?,turn?,replicaAgeMs?}` — `verdict` enum `waiting\|free\|actionable\|unresolved\|unreadable`, `source` enum `live\|replica` (always emitted — derived from the plane, not the settle). `unsettled?: string[]` — emitted only on the timeout arm. |
| `mesh-wait.schema.json` | Closed object. Required `thread,envelopes`; optional `stage,turn` — `JSON.stringify` drops the keys when undefined, so they are optional, never nullable. `stage` enum `posted\|claimed\|submitted\|accepted\|rejected`; `turn` enum `requester\|worker`. `envelopes` items: closed `MeshEnvelope` (`v` const `mesh/1`; `kind` enum `request\|claim\|result\|accept\|reject`; `body,refs,terms,evidence` required — `envelopeFromBead` always reconstructs them). `terms` closed `{priority?,deadline?:string\|null}`; `refs`/`evidence` items closed `{kind:bead\|url\|pr, ref}`. |
| `mesh-inbox.schema.json` | Closed array items: `{peer,bead}` plus the `MeshEnvelope` fields spread inline (`cmdInbox` maps `r.envelope` flat), `mismatch?/unbound?: boolean` present only when true (`\|\| undefined` drops the key). `kind` is `request` — the pending-request filter is structural, not incidental. |

### 2. Contract blocks in `plugins.ts`

- `convoy.contract.subs.next` — flags `[mol]`/`--mol <id>` (the only
  option flags), `json` ref, exits `0 emitted · 1 molecule resolution
  failed · 2 usage`. No `--json` flag: the emit is JSON by definition
  and the flag is rejected — the contract describes reality, it does
  not invent a flag.
- `wait.contract` (top-level block) — `--json`, `--every`, `--timeout`;
  `json` ref; exits `0 free · 1 unreadable · 2 unresolved (config/parse
  failures also exit 2 — usage shares the verdict) · 3 actionable ·
  4 timeout`.
- `mesh.contract.subs.{wait,inbox}` — `--json`, `--no-pull`; `json`
  refs; wait exits `0 state printed · 1 no request visible (human
  mode only — --json always exits 0) · 2 usage`, inbox exits
  `0 rows printed · 2 usage`.
- `sessions.contract.subs.resume` — flags `--print|--last|--pick`,
  exits — **no `json` ref**. The subcommand has no `--json` flag;
  per the bead, the exclusion is recorded here and beside the block
  rather than inventing one.

### 3. Producers in `contract-schema.test.ts`

One `emit()` per schema, real command functions, hermetic fixtures —
the same seams the file already drives:

| Schema | Producer |
| --- | --- |
| convoy-next | `runConvoyCommand(['next','fx-cv'])` against the file's fake-`bd` store: `db.mols['fx-cv']` carries a closed dep (`inputs[]`), an open blocker (`blocked[]`), a dep loop (`stuck[]`), an `in_progress` row and a `human` step (`gates[]`/`inProgress[]`) — every field arm populated, asserted before return (a degenerate all-done doc would still validate). |
| wait | `runWaitCommand(['external:mesh://acme/sibling:req-1','--json'])` inside `insideAsync` — bound `local` peer (`initTarget` checkout → its own `.beads`, read through `storeFor`'s `taskStoreAt` pin so the ambient `BEADS_DIR` never reroutes it) seeded with the request bead + a requester-authored reject envelope → first poll settles `actionable` and the emit covers `reason`/`stage` on the refEntry. |
| mesh-wait | `runMeshCommand(['wait','req-1','--json','--no-pull'])` — same bound-local fixture, request + claim envelopes in the peer's store → `{thread,stage:'claimed',turn:'worker',envelopes:[req,claim]}`. |
| mesh-inbox | `runMeshCommand(['inbox','--json','--no-pull'])` — peer store seeded with a clean request (`from` = binding rig) and a forged one (`from` ≠ binding) → rows cover the `mismatch` arm. |

The `main` checkout pins `mesh.rig: mesh://test/self` in
`bro.config.json` (no forge-url origin → no github self-scan) and binds
`sibling` → `mesh://acme/sibling` (`initTarget`'s github.com/acme
remote matches). `main/.beads` stays empty — every read the fixture
needs goes through `storeFor(peer)`'s explicit pin.

`breakRequired`: `convoy-next`→`mol`, `wait`→`verdict`,
`mesh-wait`→`envelopes`, `mesh-inbox`→`dropItemKey('peer')`.
All four schemas are closed at the validated level, so the
unknown-field sweep covers each.

### 4. Manifest

`npm run gen:contract` (the owning generator — `contract check --write`
never hand-edits `contract/cli.json`) after the plugins.ts change.

## Non-goals

- No `--json` flag added anywhere — `sessions resume` keeps
  `--print|--last|--pick`; `convoy next` keeps rejecting `--json` (its
  emit is already JSON).
- No schema for `mesh`'s other emitters (`request`, `peers`, lifecycle
  verbs) — action acks, out of the §4 read classification.
- No runtime validation in the shipped CLI — CI-time only.
- No engdocs pages — generated reference picks contract changes up via
  `gen:command-docs`; no curated page changes.

## Acceptance

- `schemas/cli/{convoy-next,wait,mesh-wait,mesh-inbox}.schema.json`
  exist, referenced from `plugins.ts`, resolve under `contract/cli.json`
  (`npm run check:contract` green).
- `contract-schema.test.ts` green: each new producer emits a real
  document that validates; dropping a required field and injecting an
  unknown field both fail per schema.
- `specs/bro-6ptci.2.md` §4's deferred row is discharged: four schemas,
  `sessions resume` documented as flags/exits-only.
- `npm run typecheck`, `npm run build`, `check:contract`,
  `check:command-docs`, `check:docs` all green.
