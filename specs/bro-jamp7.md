---
parent: bro-oy3k1
scope:
  - packages/rig/
  - packages/core/src/git.ts
  - packages/cli/src/commands/rig-next.ts
  - packages/cli/src/commands/next.ts
  - packages/cli/src/commands/work.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/drive.ts
  - specs/project.md
  - REVIEW.md
---

# bro-jamp7 — extract the lifecycle engine into packages/rig

Parent: `bro-oy3k1` (one lifecycle state machine per work item). The
epic's children landed the engine *inside* `packages/cli`; this bead
gives it its own package so planes/ACP consume it without spawning the
CLI.

## Problem

`packages/cli/src` is ~54% of the codebase (principal audit
bro-l8c4f, 2026-10-18). The engine — the `rig next` verdict ladder
(spec bro-oy3k1.5), the ready-set read, the item→worktree resolution —
sits in `commands/rig-next.ts` and reaches sideways into sibling
command modules (`next.ts` for `readyBeads`, `work.ts` for worktree
paths). Consequences:

- A plane or an ACP peer that wants a verdict must spawn `bro rig
  next` — a process boot, the plugin registry, a `process.exit` —
  instead of calling a function.
- The import direction is wrong: the read projection
  (`planes/agents.ts`) imports command collectors, and `loop.ts` pulls
  `loadBroConfig` back out of `plugins.ts`. Commands are the adapter,
  not the engine.

## Design

New package `@broject/rig` — the lifecycle engine as a library.
Stateless verdicts recomputed from durable state: beads claims, the
git-common agent registry, worktrees, the forge. Specs of record:
bro-oy3k1.1 §engine, bro-oy3k1.5 (ladder), bro-oy3k1.6 (the loop/drive
fold that calls it).

### Moves

| symbol(s) | from | to |
| --------- | ---- | -- |
| `rigNext`, `rigFocus`, `RigNext` | `commands/rig-next.ts` | `rig/src/next.ts` |
| `readyBeads`, `ReadyBead`, `NEVER_CLAIM_LABELS`, `storeFor` | `commands/next.ts` | `rig/src/ready.ts` |
| `worktreePathFor` | `commands/work.ts` | `core/src/git.ts` |

- `commands/next.ts` re-exports `readyBeads`/`ReadyBead`/
  `NEVER_CLAIM_LABELS` and imports `storeFor` back — existing
  importers (`loop.ts`, `next.test.ts`) are untouched.
- `commands/work.ts` re-exports `worktreePathFor` from `@broject/core` —
  the sibling-checkout naming convention gets one home next to
  `mainWorktreeRoot`. The engine's item→worktree probe now uses
  `mainWorktreeRoot(dir)`: dir-anchored instead of cwd-anchored,
  identical when invoked in-repo, correct when not.
- `runRigNext` stays in `commands/rig-next.ts`: argv → verdict →
  stdout → exit code is the adapter half.
- The lifecycle journal (`emitLifecycle`, `readLifecycle`,
  `LIFECYCLE_KINDS`) stays in core — the append plane every surface
  shares, not engine logic. rig consumes it.
- `rig sync/status/watch/install` (`rig.ts`, `rig-pulse.ts`,
  `rig-config.ts`) are the checkout-freshness verbs — a different `rig`
  concern, untouched.

### Dependencies

`rig → {core, drill}`, acyclic. The bead sketched "core only"; the
verdict ladder genuinely reads frame/queue state (`WAITING_LABEL`,
`currentFrame`, `queueItems`, `queueScope`) which lives in drill.
Rehoming frames/queues into rig is the policies tail (bro-u6fp5), not
this extraction.

### Store reads stay exactly as they are

`rigNext` keeps its split: bead rows via `opts.store ??
taskStore(dir)`, the ready/dep-gate via the facade-resolved store —
`readyBeads(dir)` gains an optional `store` pin so a caller-injected
store answers consistently instead of the probe silently reverting to
the configured backend; the no-pin path resolves `facade('tasks')`
with `loadConfig(root).connectors` exactly as `storeFor` did through
`loadBroConfig` (connectors is a core section — identical values, no
plugins.ts import).

### Boundary rule (lands in REVIEW.md)

`packages/rig` never imports `plugins.ts` or `commands/*` and never
calls `process.exit`; connector resolution goes through core's
`facade` + `loadConfig` only. Commands keep argv/stdout/exit.

## Non-goals

- No loop/drive policy rewrite — the fold is already done
  (bro-oy3k1.6); bro-u6fp5 turns them into policies over this package.
- No move of the emitLifecycle call sites into named transition
  helpers — the same tail.
- No `contract dump` identity check — that command is bro-k9ces (open);
  the byte-identical check here is the existing `rig next` e2e.

## Verify

- `packages/rig` builds standalone (`nx build @broject/rig`) and its
  `tsx --test` passes with fixtures a package can own: a scripted `bd`
  on PATH, a tmpdir git repo for the registry/worktree planes, a
  `registerConnector`'d fake reviews host — no cli plugin registry, no
  `process.exit`.
- `npm run build && npm run typecheck && npm test` at root — the cli's
  `rig-next.e2e.test.ts` passes unchanged: byte-identical verdict lines
  are the behaviour contract.
- Import audit: `loop.ts`/`drive.ts`/`rig.ts` pull `rigNext`/
  `runRigNext` from `@broject/rig`; `grep -rn "commands/\|plugins.ts"
  packages/rig/src` is empty.
- `specs/project.md` + `REVIEW.md` map the sessions capability to
  `packages/rig`.
