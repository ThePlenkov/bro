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
| `bro watch --every N --for S` | The session pulse — tick the snapshot every N seconds: holds `<git-common>/bro/pulse.lock` (one per repo, a duplicate stands by), refuses under `BRO_AGENT_ID`; `--for` is required for a session-owned pulse — the window's exit is the session's wake event; omitting it leaves an unbounded watcher only an external supervisor may own |
| `bro watch --notify` | Drop the initial snapshot plus each transition into the mailbox (`<git-common>/bro/notify/`) — a notify connector drains it into the parent session |
| `bro watch --json` | Machine-readable `{ts, attention, mols, gates, fleet, janitor?}` |
| `bro watch install [--every N] [--print]` | Arm the session pulse — writes `<git-common>/bro/pulse.json` (the want-marker session-start rearms from) and strips any legacy systemd/cron entry; cadence is `--every N` or `watch.intervalSec` (default 60). No OS timer is installed |
| `bro watch uninstall` | Disarm the marker + strip any legacy timer/cron entry; a live pulse exits on its own |

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
- **The session owns the cadence — the pulse is bounded, never
  infinite.** The orchestrator arms `bro watch --every N --for S
  --notify` in a visible background shell (`watch.pulseSec` suggests the
  window, default 900s). The window's exit IS the wake event: run one
  `bro drive` pass, digest, re-arm the next window. Never sit in a
  foreground poll, never nohup an unbounded `--every`.
- **Armed-but-dead rearms itself.** `bro watch install` writes
  `bro/pulse.json` — the durable want-record. A session start (or
  post-compaction) that finds the marker armed but no live pulse lock
  gets the rearm nudge; the orchestrator re-arms the window. OS timers
  are retired — systemd/crontab installs no longer exist; install only
  strips the legacy entries they left.
- **Only orchestrators pulse.** Sessions with `BRO_AGENT_ID` set —
  spawned workers — never see the nudge and get refused by
  `bro watch --every` / `bro drive --every`: recursion is how the
  watcher tree multiplies.
- **`--notify` is how a watcher reaches its parent.** With a notify
  connector installed, mailbox drops surface mid-turn in the parent
  session — the initial snapshot plus each transition. Dedup is
  per-process.
- **The mailbox is pull-based.** A drop never wakes a sleeping
  parent — it lands in context on the session's next tool call (the
  postTool drain). The bounded window's end is the wake boundary;
  between ticks, delivery follows the session's own tool cadence.
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
