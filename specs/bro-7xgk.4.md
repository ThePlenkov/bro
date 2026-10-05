---
parent: bro-7xgk
scope:
  - packages/cli/src/commands/convoy.ts
  - packages/cli/src/commands/convoy-run.ts
  - skills/convoy/SKILL.md
  - AGENTS.md
  - bro.config.json
---

# bro-7xgk.4 — dogfooding: replace /tmp/review-driver.sh and mol-queue2.sh with bro drive and bro convoy

## Problem

The drivers actually running the fleet are hand-rolled `/tmp` scripts.
`/tmp/review-driver.sh` reimplements `bro drive` (poll `bro act status`,
spawn detached `devin -p` fixers, pid pins in `/tmp/bro-fixer-*.pid`).
`/tmp/mol-queue2.sh` reimplements a convoy queue (sequential `devin -p`
sessions over a mol list, ≤4 attempts, journal in `/tmp/mol-queue.log`),
and a family of `mol-queue2-*.sh` wave launchers exec it with different
mol lists.

Both are strictly worse than the connector path on exactly the
properties the connector was written for: no registry entry (`bro
agents status` reads empty while workers run), no `.exit` record
(completion unprovable — only a live pid or a closed bead), no respawn
dedup, no managed claim, no fleet cap, no exit-cause classification.
And the run path can't move onto bro today even by hand: no
`agents.*.command`/`loop.agent` is configured, so `bro agents up`
refuses every spawn (`config` SpawnError) — the hand-rolled form isn't
a fallback, it is the only path that works. AGENTS.md describes it
wrongly as the fallback.

`bro drive` (bro-tui8) already covers the review driver: act-gate
polling, occupancy guards, fixer beads, facade spawns, merge-on-green.
The missing half is the molecule queue — the `mol-queue2.sh` shape.

## Design

### `bro convoy run` — the molecule queue runner

```text
bro convoy run <mol>…           run each molecule to 'complete', one at a time
bro convoy run --open           every open molecule, pour order
bro convoy run --attempts N     per-mol attempt cap (4)
bro convoy run --poll SEC       agent state poll interval (15)
bro convoy run --retry-delay SEC  spacing between crash retries (60)
bro convoy run --json           one JSON verdict line per mol
```

Sequential, like the script it replaces — an inference-budget wall is
why this epic exists, and one worker at a time is the budget-safe
default. `fleet.maxConcurrent` still bounds it (and everything else on
the fleet) at the spawn prologue.

**Per mol**, the runner:

1. Skips a molecule already `complete` (or missing from the open set
   under `--open`).
2. Spawns the convoy-runner agent through `spawnStepAgent` keyed on the
   **molecule root bead** — the claim lands on the root, the registry
   pins `{pid, log, prompt, exit}` under `<common>/bro/agents/`, and
   `bro agents status`/`bro fleet`/`bro watch` all see the worker. The
   prompt is the runner work order (the `mol-queue2.sh` prompt,
   parameterized by mol id and repo root): work the convoy to
   `state: complete`, merge is yours, no human gates.
   The worktree is the main checkout — the worker enters per-bead
   worktrees itself via the work skill, same contract as the script.
3. Polls `conn.status(agentId)` every `poll` until a terminal state.
   `status()` (not `list()`) is the probe — one targeted call, and the
   connector's harvest classifies the cause on the way.
4. On terminal, re-reads the registry entry and classifies:
   - mol `complete` → `done`, next mol.
   - mol `state: gate` → `gated` — a human gate is pending; reported,
     not retried, not failed.
   - entry `blocked`: `rate_limited` with `resetAt` → sleep until the
     provider's reset, then respawn — **no attempt burned** (a budget
     wall is not a mol failure). `rate_limited` with no reported reset
     or `quota` → `parked`, next mol — a wall with no advertised end is
     reported, not waited into (the `down` escape stays manual).
   - entry `stopped` → `stopped`, next mol — never respawn an operator
     `down`.
   - otherwise (crash/auth/`ok`-but-incomplete/`lost`) → attempts++;
     over `--attempts` → `failed`, next mol; else respawn after
     `retry-delay`.
5. `SpawnError` on spawn is a signal, not a verdict — the runner
   re-reads the registry to classify the refusal: entry `blocked` → the
   wait path above; fleet occupancy full → sleep a poll tick and retry
   (capacity, no attempt burned); entry live or claimed outside the
   registry → `occupied`, skip (a live worker owns this mol —
   occupied is always the safe verdict); anything else → attempt++.

Progress surfaces through the planes the scripts bypassed: the registry
row is the journal, `bro agents status`/`bro fleet`/`bro watch` render
it, and `--json` gives a machine-readable per-mol verdict stream. The
script's `/tmp/mol-queue.log` is retired — no parallel log.

Exit code: `1` when any mol `failed` (attempts exhausted), `0`
otherwise.

### Spawn configurability — the actual root cause

`bro.config.json` gains `agents.native.command` — the template the
scripts hardcoded (`devin -p --permission-mode dangerous
--prompt-file {promptFile}`). Without a configured command the facade
cannot spawn at all; this is the line that turns `bro agents up` from
`config` SpawnError into the working path. No model/provider is pinned
(config is user-owned; devin's own default applies).

### Docs — AGENTS.md matches reality

The "Convoy fan-out" section names the real commands: `bro convoy run`
for molecule queues, `bro agents up <step>` for single steps, `bro
drive` for post-PR supervision. The hand-rolled `nohup devin` recipe is
removed — after this lands it is not a documented path at all. The
pins/detach/point-checks policy stays (the registry writes them now).

`skills/convoy/SKILL.md` documents `run`.

### Ops migration (machine state, not PR'd)

`/tmp/mol-queue2.sh` → `exec bro convoy run "$@"` (the `mol-queue2-*.sh`
wave launchers inherit through it); `/tmp/review-driver.sh` → `exec bro
drive --every 300`. Done at closeout on this machine.

### Follow-up bead (the "separate child" the bead notes promise)

`convoy run: fast-fail backoff` — port mol-queue2's 900/1800/3600s
exponential ramp on sub-300s exits into `bro convoy run` (v1 ships flat
`--retry-delay` spacing; cause-aware waits already cover the
rate-limit case the ramp was really for).

## Plan

- [ ] `packages/cli/src/commands/convoy-run.ts` — arg parsing, mol
      iteration, spawn + poll + classify loop, prompt template —
      spawn/status/registry/sleep all injectable for tests
- [ ] `convoy.ts` — wire `run` subcommand + usage
- [ ] `bro.config.json` — `agents.native.command`
- [ ] `AGENTS.md` convoy fan-out rewrite; `skills/convoy/SKILL.md` `run`
      section
- [ ] `convoy-run.test.ts` — args, classification matrix (blocked /
      stopped / gated / cap-refusal / occupied / crash-retry /
      attempts-exhausted), prompt rendering
- [ ] Follow-up bead filed under bro-7xgk for the exponential backoff
- [ ] `npm test` (exact CI command)
- [ ] Closeout: replace the two `/tmp` drivers with `exec bro …` shims
