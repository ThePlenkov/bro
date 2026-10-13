# bro-5houx — `bro fleet resume`: the post-restart recovery pass

## Problem

A host or session restart kills processes and keeps promises: claims,
worktrees, the agent registry, `daemon.json`, watch markers, and
`loop.lock` all survive — watchers, the daemon, the loop, and exec
shells do not. Recovery today is a manual runbook (lesson
`learn-post-reboot-bro-recovery`): reap → audit claims/worktrees/
registry → `bro review act rearm` → restart daemon/loop. Every leg exists as
its own command; nothing orders them, and the state report names the
symptoms (`stale act watch on #N`, `daemon down`) while leaving the
fixes to per-PR, per-process typing.

## Decision

`bro fleet resume [--dry-run] [--json]` — the runbook as one pass over the
main worktree. Orchestrator-only (`BRO_AGENT_ID` refuses, exit 2 —
same predicate as `bro fleet daemon up`: a spawned worker never arms
supervisors). Legs run in the runbook's order; each reports what it
found and what it did:

1. **sweep** — `runJanitor`: dead session markers and residue files
   reaped (the same sweep `bro watch` already runs each tick).
2. **watch** — `act rearm` mechanics: every dead watch marker whose PR
   is still open gets a detached `act wait` respawned at its recorded
   mode; settled markers sweep, and a settled marker carrying a
   loop-claimed bead reconciles exactly like `cmdRearm` (merged →
   discharge the claim). Kept markers report their reason.
3. **daemon** — `driveRearm` + `supervisorUp`: `drive.json` (the
   durable want-marker `bro drive install` writes) with a dead
   supervisor is armed intent lost to the restart — `supervisorUp`
   respawns at the marker cadence under `daemon.up.lock` with the
   marker re-checked inside. `daemon.json` is only the transient spawn
   record — dead without a marker it is residue, never intent. Live →
   report. Never armed → skip: resume restores recorded intent, it
   does not invent it.
4. **loop** — `bro/loop.lock` holder dead and/or `collectLoopRuns`
   dead records: report per-run (`bead`, `slug`, log path) and reap
   the residue. The loop itself is **never auto-spawned** — claiming
   the backlog is a run-level decision and a detached loop has no
   recorded armer intent the way `drive.json` gives the daemon one.
   Output carries the `bro flow loop` restart hint.
5. **agents** — `collectAgentBackends`: registry entries whose pids
   died read as lost/exited — reported per backend (degraded backends
   report degraded, never counted). `bro fleet agents prune` sweeps
   terminal entries, `bro fleet agents up <step>` respawns — hints, not
   actions.
6. **worktrees** — `git worktree list --porcelain` + per-tree status:
   sibling worktrees with uncommitted changes reported with dirty
   counts (the runbook's "check each loop/* worktree for uncommitted
   work" — a restart strands agent edits otherwise).

`--dry-run` prints the plan — would-rearm watches (respawn omitted,
markers untouched), would-spawn daemon, the same audits — and mutates
nothing. `--json` emits the structured report for the planes.

### Refusals

- Never merges, never closes beads beyond the rearm reconcile, never
  spawns `bro flow loop`, never touches dirty worktree contents.
- A resume inside a worker (`BRO_AGENT_ID`) exits 2.
- Exit 0 whenever the pass completed — dead processes are the input,
  not a failure. Exit 2 on usage and the worker refusal.

## Mechanics

- `packages/cli/src/commands/resume.ts` + registration in
  `plugins.ts` (`name: 'resume'`, group `fleet`, `skill: 'resume'`) +
  `skills/resume/SKILL.md` + `resume.e2e.test.ts`.
- Reuses, never reimplements: `runJanitor`/`janitorLine`
  (`@broject/core`), `rearmWatches` + `respawnWatcher` + the
  settled-bead reconcile (`act.ts` — the rearm core gets one exported
  helper both callers share), `daemonProbe`/`driveRearm`/`supervisorUp`/`readDriveMarker`
  (`daemon.ts` — the session-checkpoint decision + spawn path), `collectLoopRuns` +
  `reapLoopRuns` (`loop-state.ts`), `collectAgentBackends` +
  `loadAgentEnv` (`agent-connectors.ts`/`agents.ts`),
  `lockHolderPid`/`pidAlive`/`gitTry` (`@broject/core`),
  `isOrchestratorSession` (`watch-pulse.ts`), `mainWorktree`
  (`work.ts`).
- Root resolution mirrors `daemon`: `mainWorktree().path` — the resume
  acts on the main checkout's bro dir even when run from a linked
  worktree.

## Test plan

- `resume.e2e.test.ts` over `runCli` + fake-host fixtures: dead
  watch marker → detached wait respawned, marker swept; recorded-dead
  daemon → revived at recorded cadence; dead loop.lock + run records →
  reported + reaped; dead registry entries → reported; dirty sibling
  worktree → listed; worker env → exit 2; `--dry-run` leaves every
  artifact untouched.
- `daemon.test.ts` — `daemonRevive` over `initRepo` fixtures with the
  spawn seam stubbed: live holder reports, never-armed stays unarmed,
  recorded-dead respawns at the recorded cadence.
