# bro-ejblu — adhoc molStep mint is uniqueness-checked

## Problem

`bro fleet delegate --detach` and `bro agents run` mint their phantom
step id as `adhoc-${randomBytes(4).toString('hex')}` — 32 bits, drawn
blind against the agent registry (`<git-common>/bro/agents.json`,
keyed by molStep). A mint that lands on an existing key is not a fresh
step: `prepareSpawn`'s `guardExistingEntry` either throws
`SpawnError` (`<step> already has a live agent` — the delegate/run
dies outright) or, when the entry is dead, respawns over it —
reusing its agentId and overwriting a row that was never this run's
(clobbering its attempts/learn history). Deferred finding from the
PR #652 review.

## Fix

`mintAdhocStep(dir)` in `@broject/core` (beside `mintAgentId`/
`mintRunId`): mints `adhoc-<8hex>` and re-mints while the candidate
already keys a registry entry, the check riding
`withAgentRegistryLock` so the read can't go stale mid-verdict.
Outside a git common dir there is no registry to collide with — mint
and go. Both mint sites call it:

- `delegate.ts` `delegateDetach` — `molStep: mintAdhocStep(dir)`
- `agents.ts` `cmdRun` — `forBead ?? mintAdhocStep(dir)`

The spawn still revalidates under its own registry lock downstream:
the residual mint→spawn window can only degrade to the existing loud
conflict, never a silent overwrite of a live agent. The id shape
(`adhoc-<8hex>`) is unchanged — the phantom-namespace predicate
(`isPhantomAdhoc`), worktree naming, and status/down handles are
untouched. An optional `mint` parameter is the test seam (scripted
candidates force a registry hit deterministically); `DelegateOpts`
exposes it as `mintStep` alongside the existing `fetch`/`acp` seams.

## Out of scope

- Closing the mint→spawn check-then-act window inside the spawn
  prologue — the window's failure is already a loud conflict, and a
  phantom-mint flag on `SpawnSpec` touches every backend for no
  observed loss.
- `agentId`/`runId` mint widths — same 32-bit space, different (and
  already guarded) collision semantics.

## Tests

- `agents.test.ts` (`@broject/core`): seeded registry + scripted mint
  returning the taken key first → `mintAdhocStep` returns the fresh
  candidate, the seeded row untouched; shape `adhoc-<8hex>`; non-repo
  dir mints without a registry.
- `delegate.test.ts`: `--detach` with `mintStep` scripted
  `[taken, free]` over a registry seeded with `taken` → the agent
  registers under `free`; the `taken` row is never rewritten.
- `bro spec check bro-ejblu` passes.
