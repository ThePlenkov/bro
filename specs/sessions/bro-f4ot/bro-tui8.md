# bro-tui8 — bro drive — the post-PR review driver

Parent: `bro-f4ot` (agents facade + bro fleet). `bro watch` is the
read-only heartbeat: it reports `PR #N blocked — open_threads`. `bro
drive` is the write-side counterpart for that one attention class — it
acts on orphaned PRs, nothing else.

## Problem

A convoy/loop session's job ends at PR-open; the review loop does not.
Threads that arrive after the owner session exits have no owner — the
`bro-mol-3n2`/656-min stall proved it: review rounds kept landing on
open PRs while nothing resolved them. The interim fix was a hand-rolled
`/tmp/review-driver.sh` (poll `bro act status`, spawn `devin -p` fixers,
pgrep guards) — real enough to keep shipping, wrong enough to race a
live owner (bro-pywx) and invisible to `bro fleet`.

The gap is not "watch harder" — it is a supervisor that *owns* the loop:
poll the exit gate → spawn a fixer agent through the facade (not an
anonymous nohup) → merge on green.

## Design

```text
bro drive [--once]        one supervision pass over open PRs (default)
bro drive --every N       a pass every N seconds — cadence owned by
                          the deployment, same contract as bro watch
bro drive --no-merge      supervise only — never merge (drive.merge too)
bro drive --json          one JSON line per PR verdict
```

`drive` config section: `{intervalSec: 300, merge: 'auto'|'never'}`.

### Candidate set

Open PRs on fleet branches — every worktree's branch plus local
`work/*`, `loop/*`, `stack/*` branches (a `bro work leave` orphans the
PR, not the branch). Branch → open PRs via `prsForBranch`; per-PR
lookup failures are reported, never read as "no PRs".

### Per-PR verdict each pass

1. `fetchPrActState` + `evaluateExitGate` (the repo's
   `act.ignoreChecks`/`maxRounds` — the same gate `bro act status`
   shows).
2. `state ≠ OPEN` — close the PR's fixer bead if one is still open.
3. `gate.ok` — green. **Occupied?** report `green — owner live` and
   leave the merge to the owner session. Orphaned → `bro act merge`
   (the gate re-evaluates inside; merge slot + expectedHeadSha pin
   apply), then retire the worktree when clean and close the fixer
   bead. `drive.merge: 'never'`/`--no-merge` reports `green` and
   stops there.
4. `open_threads > 0` — **occupied?** skip (`occupied — <why>`); a live
   session owns the worktree and its own review loop. Orphaned →
   spawn/respawn the fixer agent for the PR's fixer bead.
5. Otherwise (CI/reviewers pending, hard blockers) — report, no action.

### Occupancy — the guard bro-pywx hardens

A PR is *occupied* when any plane reports a live worker on its
worktree — spawning then would race the owner (the incident this bead
exists because of). Layers, cheap to strong:

- **agent plane** — a facade agent (any backend) live against the
  fixer bead, or recorded with this worktree.
- **`.work` markers** — a fresh `<common>/bro/hooks/*.work` marker
  whose detail names the branch/slug/worktree (the same signal
  session-start parallel detection reads).
- **`/proc` cwd scan** — a live process whose cwd sits inside the
  worktree AND whose cmdline matches a known agent CLI
  (`devin|claude|codex|gemini|aider|opencode`) or carries
  `BRO_AGENT_ID` in its environ. Linux-only layer — absent `/proc`
  skips it (the first two planes still apply); it is a fallback for
  sessions that never armed a marker.

Occupied is always the *safe* verdict: worst case is a PR waits a
pass, never double-work on one branch.

### The fixer bead

One persistent bead per PR, lazily created: label `fixer`,
`external_ref = drive:pr:<n>` (idempotent upsert across passes — a
dead session's restart finds the same bead). The fixer's `molStep` is
this bead — which buys the whole facade contract for free:

- live fixer → `spawn` refuses (dedup);
- dead fixer → respawn rebinds the claim on the **same agentId** —
  bro-q0f2's respawn semantics, the use case they were built for;
- `bro fleet`/`bro agents status` see the fixer — no more anonymous
  `/tmp` processes.

The work bead's claim is never touched — a fixer does not steal
ownership of the work, it resolves review threads on its PR.

### Fixer worktree + prompt

Reuse the worktree the PR branch is checked out in. Gone → create
`<repo>--<slug>` on the branch (`git fetch` first; local branch →
`worktree add <dir> <branch>`, else `--track` off `origin/<branch>`).
A dir standing on a *different* branch is skipped, never clobbered.

The prompt carries the unresolved thread list (`reviewThreads` at
spawn time), the PR link, the branch, and the rules: fix on this
branch, push, resolve silently on fix / reply+resolve on reject,
defer non-blocking nits to debt beads, **never merge** — the driver
owns the merge. `BRO_PR`/`BRO_PR_URL` ride in `spec.env`.

## Plan

- [ ] `packages/core/src/agents.ts` — `driveSection` config schema
      (intervalSec, merge)
- [ ] `packages/cli/src/commands/drive.ts` — arg parsing, candidate
      enumeration, occupancy verdict, fixer-bead upsert, spawn, merge
- [ ] `bro drive` plugin entry (`drive`, skill `drive`, config
      `drive`) in plugins.ts
- [ ] `skills/drive/SKILL.md` + `agents/openai.yaml`; regen
      skills-data
- [ ] `drive.test.ts` — args, candidate set, occupancy layers,
      fixer-bead lookup (fixture repo)
- [ ] `npm test` (exact CI command)
