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
| `bro watch --notify` | Drop the initial snapshot plus each transition into the mailbox (`<git-common>/bro/notify/`) — a notify connector drains it into the parent session |
| `bro watch --json` | Machine-readable `{ts, attention, mols, gates, fleet, janitor?}` |
| `bro watch install [--every N] [--print]` | Install the heartbeat on a non-agent timer — a systemd user unit running `--once --notify` per repo (crontab fallback); cadence is `--every N` or `watch.intervalSec` (default 60) |
| `bro watch uninstall` | Remove the installed timer/cron entry for this repo |

Every tick also rewrites `<git-common>/bro/heartbeat.json` — the durable
last-known-state file. Mailbox drops expire after ~1h; this file does
not, so overnight state is a read (`bro status` row, session-start
context), never an inference from whether a session was polled.

## Policy

- **Read the attention list, not the table.** The snapshot leads with
  what needs a decision: ready human gates, `lost — respawn?` agents,
  blocked PR exit gates, failed gate probes. `(quiet)` means no
  listed attention condition fired — not an all-clear: check the
  degraded / unavailable / probe-failed lines before treating the
  snapshot as healthy, and don't go hunting for work the heartbeat
  didn't raise.
- **Detach the watcher, don't block on it.** `--every` runs until
  killed — spawn it detached (nohup, background subagent, systemd-run)
  or let the deployment own the cadence by re-invoking `--once` on a
  schedule. Never sit in a foreground poll.
- **`--notify` is how a watcher reaches its parent.** With a notify
  connector installed, mailbox drops surface mid-turn in the parent
  session — the initial snapshot plus each transition. Dedup is
  per-process: a scheduled `--once --notify` run always emits.
- **The holder is not the watcher.** A session that must stay alive
  waiting on background work keeps a bare-sleep **holder** — a
  background subagent whose ONLY tool call is a sleep (~15 min
  cadence). It collects no snapshot, runs no `bro watch`, writes no
  report; its completion is the parent's wake boundary. Polling,
  snapshotting, and reporting all belong to `bro watch install`'s
  timer — zero inference per tick — never to a billed agent loop. A
  3-min holder polling the fleet cost ~18–40% of a session's measured
  requests; a 15-min bare-sleep holder is ~8–12 req/hour. Shorten only
  when measured completion-notification latency demands it.
- **The mailbox is pull-based.** A drop never wakes a sleeping
  parent — it lands in context on the session's next tool call (the
  postTool drain). The holder is load-bearing for exactly that reason:
  removing it requires a push path first.
- **Watch never touches your work.** It never claims steps, never
  mutates beads, never respawns agents — a `lost — respawn?` row is the
  decision surface; respawning is a manual act (`bro agents up <step>`).
  The writes besides `--notify` drops are the heartbeat file (each
  tick's snapshot, atomically replaced) and the janitor: each tick
  reaps dead session/agent state under `<git-common>/bro/` (retention,
  not workflow) and reports it in the attention list.
- **Degraded is not dead.** A backend whose `list()` failed renders its
  rows `unknown`, never `lost` — don't respawn on a failed read.
- **Report progress in words, not IDs.** When relaying snapshot state
  to the user, translate every code: `bro-mol-3n2` → "the notify
  connector molecule", `bro-mol-0io` → "the `bro watch` molecule".
  A status line must say what the agent is *doing* and what just
  *landed* ("PR for X merged, session moved to Y") — bare mol/bead/PR
  IDs alone are not a report. IDs may appear in parentheses.
