# bro-oy3k1.4 — spawn owns enter/claim/spawn as ONE transition

Parent: bro-oy3k1 (unified rig engine — one lifecycle state machine per
work item, beads is the store, `events.jsonl` is the log).

## Problem

Today `bro fleet agents up <step>` only *resolves* a worktree — when none
exists it errors `run \`bro work enter <step>\` first`. The operator (a
loop, a convoy runner, a human) must run two commands across two
subsystems, and each is claimed differently: `work enter` stamps the
bead onto the *session* actor while the spawn wants it on the *worker*.
Between them the transition is non-atomic — a drive retire or a quota
refusal in the gap strands half-state (the stranded-claim bug class,
cf. bro-aqjji).

## Contract

`bro agents up <step>` (and `POST /api/v1/agents`) with no resolvable
worktree performs the whole transition inside the agent-registry lock:

1. `resolveWorktree` returns a create-intent instead of throwing — the
   conventional `<repo>--<step>` path plus `work/<step>` branch off the
   main checkout's branch.
2. `prepareSpawn`, still under `withAgentRegistryLock`, after all refuse
   paths (existing-entry guard, claim guard, fleet cap, session quota)
   and before the registry write: `createWorktree` + `claimWorktree`
   stamp. A `gone`/`lock-timeout`/git failure aborts the spawn — no
   registry entry, no claim.
3. `claimStep` lands the bead claim as today — the worker's claim, never
   the spawner's session.

The remote-only copilot backend is unchanged (it binds `dir`, no
worktree). Explicit `--worktree` or an already-recorded/conventional
tree takes the existing path — creation only fires when nothing
resolved.

## Mechanism

- `SpawnSpec.enter?: { branch, base?, mainPath }` — create intent on the
  spec; connectors get it for free through `spawnHome`/`prepareSpawn`.
- `EnterWorktreeOpts.throws` — library callers get an exception, not a
  `process.exit` (the serve host must not die on a git error).
- `EnterWorktreeOpts.beadClaim: false` — `finishWorktreeEnter` skips
  `claimBead`; the spawn's `claimStep` is the bead claim.
- `claimWorktree` opts `preLocked` — the caller already holds the
  registry lock, so the stamp's inner `acquireAgentRegistryLock` is
  skipped (the in-tree claim lock still serializes vs `work enter`
  stamps).
- `spawnHome`'s `existsSync(repoRoot)` check defers when `enter` is set —
  the post-create state is what matters.

Failure bookkeeping: a claim refusal after tree creation leaves the
registry's `lost` entry pinning the worktree — the next `agents up`
respawns into it, same as an enter-then-crash today.

## Tests

- e2e: `agents up` with no worktree → worktree created, bead claimed,
  agent spawned; second `up` on the same step is the existing-entry path.
- claim-refused (bead in_progress, no registry entry) → refusal, and no
  worktree left behind (guards run before create).
- spawn-refused cleanup: quota/cap refusal leaves no worktree (create
  runs after the refuse paths).
