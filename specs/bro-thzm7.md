---
scope:
  - packages/core/src/tasks.ts
  - packages/core/src/bd.ts
  - packages/core/src/agents.ts
  - packages/core/src/routing.ts
  - packages/core/src/connectors.ts
  - packages/cli/src/commands/sync.ts
  - packages/cli/src/commands/status.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/githooks.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/act.ts
  - packages/cli/src/doctypes/store.ts
  - packages/cli/src/planes/helpers.ts
  - packages/cli/src/planes/queue.ts
  - packages/cli/src/planes/learn.ts
  - packages/mesh/src/post.ts
  - packages/act/src/merge-slot.ts
  - packages/convoy/src/molecule.ts
  - packages/drill/src/frames.ts
  - packages/learn/src/capture.ts
  - packages/github/src/tasks.ts
  - packages/linear/src/tasks.ts
---

# bro-thzm7 — taskstore boundary audit: port speaks domain verbs, bd stays in the connector

## Problem

The `TaskStore` port exists and connector-driven selection
(`facade('tasks', {dir}, {prefer})`) is live — beads today, github and
linear already implement the facade, planes are queued. But business
logic still reaches around it: every audited call below answers a
domain question by shelling `bd` outside the connector:

- `commands/sync.ts` execs `bd sync` — replication is a backend
  transport concern, not a command concern.
- `commands/status.ts` parses `bd list`/`bd ready` rows — the serving
  store (maybe not beads) already answers through `list`/`ready`.
- `commands/githooks.ts` `bd show` for a `parent` field — `get()` is
  the port verb.
- `commands/loop.ts` `bd where` to pin `BEADS_DIR` — the store's own
  data-dir is a connector fact.
- `planes/helpers.ts` `bd list -n 1` as a reachability probe — the
  probe belongs on the serving store, not on a hardcoded backend.
- `doctypes/store.ts` `bd init`/`bd config get` — store provisioning
  and the prefix probe are connector verbs (`prefix()` already exists;
  `init` doesn't).
- `commands/agents.ts` + `core/agents.ts` + `core/routing.ts` — the
  shared-claim plane (probe/claim/rebind/parent/class reads) runs on
  `bdAt`, a parallel spawn wrapper. Scheduler code must speak the
  port's verbs.
- `mesh/src/post.ts` carries a private `bd()` for create/update/`dep
  add` — all three are port verbs.
- `act/src/merge-slot.ts` runs `bd merge-slot` — a cross-session slot
  is a store capability, domain verb `slot`.
- `act.ts` `deferThread` creates on bare `taskStore()` — always beads —
  while the claim plane beside it resolves the configured store. A
  defer bead belongs on the store that serves claims.

Relations have a second, subtler leak: `deps`/`link` accept and emit
bd's native type names (`parent-child`, `blocks`, `discovered-from`),
so domain code (`drill`'s frame tree, `learn`'s evidence harvest)
speaks the backend's dialect. The port must speak
`parent | blocked | related | discovered | tracks` and map to each
backend's names inside the connector.

## Design

### Optional capabilities — presence advertises the verb

`TaskStore` gains four optional members (absence is honest — "this
backend can't answer", callers degrade, never fake):

```ts
/** Backend replication — one full cycle (beads: dolt refs pull+merge
 *  +push; remote backends typically sync on write and omit this).
 *  Returns output for the caller to print; '' when nothing moved. */
sync?(): string
/** The backend's own data directory — beads answers `bd where`
 *  (used to pin BEADS_DIR into spawned envs); file-less backends
 *  omit it. Throws when the store can't answer. */
dataDir?(): string | undefined
/** Store provisioning — beads runs `bd init --non-interactive
 *  --init-if-missing [--prefix p]`; remote backends omit it. Returns
 *  captured output for the caller to print. */
init?(opts?: { prefix?: string }): string
/** Named cross-session slot — 'merge' is the merge critical section.
 *  Absent means the backend has no slot primitive (fail-open:
 *  coordination, never enforcement). */
slot?(name: string): TaskSlot | undefined
```

`TaskSlot`:

```ts
export type SlotAcquire =
  | { kind: 'acquired' }
  | { kind: 'held'; holder: string }
  | { kind: 'unavailable' }   // backend can't answer — callers proceed

export interface TaskSlot {
  acquire(): SlotAcquire
  release(): void
  holder(): string | null
}
```

`TaskStoreAsync` gains `slotHolder?(name): Promise<string | null>` —
the probe-path half of `slot` (the merge slot's session-start read).

### Generic relation vocabulary

`deps`/`link` speak domain rels; each connector maps to its own names:

| port rel      | beads           | github              | linear        |
| ------------- | --------------- | ------------------- | ------------- |
| `parent`      | `parent-child`  | sub-issues          | parent        |
| `blocked`     | `blocks`        | blocked_by deps     | blocks        |
| `related`     | `related`       | — (throws)          | — (throws)    |
| `discovered`  | `discovered-from`| — (throws)         | — (throws)    |
| `tracks`      | `tracks`        | — (throws)          | — (throws)    |

- `deps(ids, opts)` — `opts.type` becomes `opts.rel` (domain names).
  Edge rows in the result carry the GENERIC name in `type` —
  connectors normalize both directions, so a caller never sees
  `parent-child`. Native names remain accepted on input (normalized)
  so nothing mid-flight breaks, but no caller emits them.
- `link(from, to, rel)` — same vocabulary; `from is rel-of to`
  (`blocked` = "from is blocked by to", matching `bd dep add` and the
  existing github/linear contract).
- `TaskInput.deps` specs (`'<rel>:<id>'`) map through the same table —
  `discovered:<id>` lands as `discovered-from:<id>` on beads.
- `.N` child ids stay backend-internal: callers already use `parent`
  field reads and `children()` — nothing in the tree constructs ids
  by suffix.

### Store pinning — `taskStoreAt(beadsDir)`

The shared-claim plane addresses a store by `BEADS_DIR`, not cwd.
`bdAt` moves from `agents.ts` to `bd.ts` (it is a spawn variant, not
domain code), and `taskStoreAt(beadsDir)` builds a `TaskStore` over it
— same implementation, different routing (env pin vs cwd). The claim
plane's verbs then read `get`/`claim`/`update`/`create` through the
port:

- `probeStep`/`stepParent`/`stepClassInfo` → `store.get(...)` field reads
- `claimStep` → `store.claim(...)`; `rebindStep` → `store.update(...)`.
  The `ran` flag rides on the thrown error so the conflict/unavailable
  classification survives (`ran:false` → `unavailable`, else `conflict`).

### Conversions

- **sync.ts** — `sync.beads` config still gates the replication leg.
  The leg now resolves through the connector: the serving tasks
  store's `sync?.()` runs, and — when the serving backend isn't beads
  but a local `.beads` doc store exists — the local beads connector's
  `sync?.()` too (kv/mol docs live there regardless of tasks backend).
  ENOENT/no-capability = silent skip; a real failure warns, never
  breaks artifact sync.
- **status.ts** — `list({status:'in_progress'})` + `ready()` through
  `facade('tasks')`; per-section try/catch keeps the board's
  empty-sections contract when the backend is absent or dead. Board
  fields pick off `TaskRow` (it already carries description etc. —
  no widening needed).
- **loop.ts** — `resolveBeadsDir` becomes `store.dataDir?.()` on the
  resolved store (still beads-gated by the caller).
- **githooks.ts** — `beadMolecule` reads `get(bead)?.parent`.
- **planes/helpers.ts** — `beadsReachable` → `tasksReachable`,
  `tasksAsync(dir, prefer).list({limit:1})` in try/catch.
- **doctypes/store.ts** — `storeInfo` probes `store.prefix()`;
  `initStore` runs `store.init?.({prefix})` then verifies via
  `prefix()`. `bro store` stays about beads dirs — the verbs just
  move inside the connector.
- **mesh/post.ts** — `create` + `update({'set-labels','external-ref'})`
  + `link(waiting, external:rig:id, 'blocked')` on `taskStore(dir)` —
  mesh is beads-federated by design, so it uses the beads connector
  through the port, not a hand-rolled spawn.
- **act merge-slot** — `acquire/release/holder` delegate to
  `facade('tasks', {dir: cwd}).slot?.('merge')`; the JSON parsers move
  into the beads connector (re-exported for tests). Non-beads backend
  → `unavailable` → proceed, same fail-open contract.
- **act.ts deferThread** — creates through `claimStore(cwd)` (the
  serving store), matching the claim discharge beside it.
- **convoy/molecule.ts** — `bd list --type molecule` →
  `list({type:'molecule'})`; `bd show` in `stepInputs` → `get()`;
  `bd info` → `dataDir?.()`. `bd mol`/`formula`/`config` stay —
  molecules are a beads subsystem, not task rows (the port's own
  header documents this split).
- **drill, learn** — `deps` calls switch to `rel: 'parent'` /
  `rel: 'discovered'`; edge checks read the generic names.

### What stays direct — and why

- `commands/doctor.ts` — diagnostics; the RULE's own carve-out.
- `doctypes/task.ts` `bro task exec` — documented escape hatch.
- `commands/sweep.ts` (`set-state`/`export`/`provenance`/`prune`/
  `flatten`), `learn/store.ts` (`kv`), `convoy`/`drill`/`retro`/`act`
  (`mol`/`formula`/`provenance`), `commands/drill.ts` (`mol distill`)
  — beads *doc/lifecycle subsystems* the port deliberately documents
  as absent "until they get doc types". Not task verbs; a
  docs/lifecycle facade is a separate bead, not this one.
- `bdActor`, `probeBdCompat`, `initBeadsStealth` — already connector
  internals in core.

## Test plan

- `npm run build`, `npm run typecheck`, `npm test` (the CI trio).
- The `testrepo` fake already implements `where`/`merge-slot`/`dep`/
  `sync`/`config get` — converted call sites keep passing under it.
- Focused runs: status/sync/doctors tests, act merge-slot tests,
  mesh post tests, drill frame tests.
