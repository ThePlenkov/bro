---
name: watch
description: "Use when supervising parallel convoys/agents — 'watch the fleet', 'what needs attention', a monitor loop over mols/PRs. Thin wrapper over the bro CLI: `bro watch` is the deterministic heartbeat — one snapshot of molecules, PR exit gates, and the fleet. Requires `bro` (npx -y @broject/bro@0) and bd."
---

# /watch (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — the
arming decision (when a session should run a watcher) lives here, the
snapshot mechanics live in `bro watch`.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`, `bd` initialized.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro watch [--once]` | One snapshot — the heartbeat call: attention list + open molecules + act gates per fleet PR + fleet rows |
| `bro watch --every N` | Tick the snapshot every N seconds until killed |
| `bro watch --notify` | Drop each tick's snapshot into the mailbox (`<git-common>/bro/notify/`) — a notify connector drains it into the parent session |
| `bro watch --json` | Machine-readable `{ts, attention, mols, gates, fleet}` |

## Policy

- **Read the attention list, not the table.** The snapshot leads with
  what needs a decision: ready human gates, `lost — respawn?` agents,
  blocked PR exit gates, failed gate probes. `(quiet)` means act on
  nothing — do not go hunting for work the heartbeat didn't raise.
- **Detach the watcher, don't block on it.** `--every` runs until
  killed — spawn it detached (nohup, background subagent, systemd-run)
  or let the deployment own the cadence by re-invoking `--once` on a
  schedule. Never sit in a foreground poll.
- **`--notify` is how a watcher reaches its parent.** With a notify
  connector installed, mailbox drops surface mid-turn in the parent
  session — transitions only, not every tick.
- **Watch is read-only.** It never claims steps, never mutates beads,
  never respawns agents — a `lost — respawn?` row is the decision
  surface; `bro agents` owns the respawn.
- **Degraded is not dead.** A backend whose `list()` failed renders its
  rows `unknown`, never `lost` — don't respawn on a failed read.
