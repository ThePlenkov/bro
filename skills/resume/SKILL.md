---
name: resume
description: "Use after a host/session restart to recover the rig — dead watches, a recorded-but-dead daemon, loop residue, lost agents, dirty worktrees. `bro fleet resume` is the post-reboot runbook as one pass. Thin wrapper over the bro CLI — mechanics live in the CLI. Requires `bro` (npx -y @broject/bro@0)."
---

# /resume (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

A restart kills processes and keeps promises: claims, worktrees, the
agent registry, `daemon.json`, watch markers, and `loop.lock` survive —
watchers, the daemon, the loop, and exec shells do not. `bro fleet
resume` is the recovery runbook as one ordered pass.

## Command

- `bro fleet resume [--dry-run] [--json]` — orchestrator-only
  (`BRO_AGENT_ID` refuses: a spawned worker never arms supervisors).
  Runs on the main worktree's bro dir even from a linked checkout.

Legs, in order:

| Leg | Restores | Reports |
| --- | -------- | ------- |
| sweep | janitor reap of dead session residue | reap counts |
| watch | detached `act wait` per dead marker on an open PR; settled markers sweep + reconcile | rearmed / settled / kept |
| daemon | recorded-but-dead `daemon.json` → `daemon run` at the recorded cadence | live / revived / unarmed |
| loop | — | dead `loop.lock` holder + dead run records, `bro flow loop` hint |
| agents | — | lost/exited registry entries, `bro fleet agents prune`/`up` hints |
| worktrees | — | dirty sibling trees (stranded edits) |

`--dry-run` prints the same plan with nothing spawned and nothing
swept; `--json` emits the structured report.

## Policy

- **Resume restores recorded intent, never invents it.** A daemon that
  was never armed stays unarmed; `bro flow loop` is never auto-spawned
  — claiming the backlog is the operator's call.
- **It is a report, not a gate** — exit 0 whenever the pass completed;
  dead processes are the input, not a failure.
- Run it once per repo after a restart, before `bro flow loop` —
  rearmed watchers and a revived daemon own the PRs the loop's workers
  produced while everything was down.
