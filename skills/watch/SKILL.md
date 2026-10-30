---

name: watch
description: "Use when supervising parallel convoys/agents — 'watch the fleet', 'what needs attention', a monitor loop over mols/PRs, or a read-only watchdog tick over a lane ('watch the lane', rate walls, resets). Thin wrapper over the bro CLI: `bro review watch` is the deterministic heartbeat — one snapshot of molecules, PR exit gates, and the fleet. Requires `bro` (npx -y @broject/bro@0) and bd."
---

# /watch (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — the
arming decision (when a session should run a watcher) lives here, the
snapshot mechanics live in `bro review watch`.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`, `bd` initialized.

## Commands

| Command                                          | What it does                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bro review watch [--once]`                      | One snapshot — the heartbeat call: attention list + open molecules + act gates per fleet PR + fleet rows                                                                                                                                                                                                                                   |
| `bro review watch --every N --for S`             | The session pulse — tick the snapshot every N seconds: holds `<git-common>/bro/pulse.lock` (one per repo, a duplicate stands by), refuses under `BRO_AGENT_ID`; `--for` is required for a session-owned pulse — the window's exit is the session's wake event; omitting it leaves an unbounded watcher only an external supervisor may own |
| `bro review watch --notify`                      | Drop the initial snapshot plus each transition into the mailbox (`<git-common>/bro/notify/`) — a notify connector drains it into the parent session                                                                                                                                                                                        |
| `bro review watch --json`                        | Machine-readable `{ts, attention, mols, gates, fleet, janitor?}`                                                                                                                                                                                                                                                                           |
| `bro review watch install [--every N] [--print]` | Arm the session pulse — writes `<git-common>/bro/pulse.json` (the want-marker session-start rearms from) and strips any legacy systemd/cron entry; cadence is `--every N` or `watch.intervalSec` (default 60). No OS timer is installed                                                                                                    |
| `bro review watch uninstall`                     | Disarm the marker + strip any legacy timer/cron entry; a live pulse exits on its own                                                                                                                                                                                                                                                       |

Every tick also rewrites `<git-common>/bro/heartbeat.json` — the durable
last-known-state file. Mailbox drops expire after ~1h; this file does
not, so overnight state is a read (`bro fleet status` row, session-start
context), never an inference from whether a session was polled.

## Policy

- **Read the attention list, not the table.** The snapshot leads with
  what needs a decision: ready human gates, `lost — respawn?` agents,
  blocked PR exit gates, failed gate probes. `(quiet)` means no
  listed attention condition fired — not an all-clear: check the
  degraded / unavailable / probe-failed lines before treating the
  snapshot as healthy, and don't go hunting for work the heartbeat
  didn't raise.
- **The session owns the cadence — the attended leg is `bro pulse`.**
  A live orchestrator session arms `bro pulse <S>` in a visible
  background shell (the `/pulse` skill) — a continuous metronome whose
  mailbox ticks are the wakes. The bounded form, `bro review watch
  --every N --for S --notify` (`watch.pulseSec` suggests the window,
  default 900s), is the unattended leg — what the checkpoint respawns
  from `pulse.json` when no session's pulse holds the lock. Never sit
  in a foreground poll, never nohup an unbounded `--every`.
- **Armed-but-dead rearms itself.** `bro review watch install` (and
  every `bro pulse` start) writes `bro/pulse.json` — the durable
  want-record. A session start (or post-compaction) that finds the
  marker armed but no live pulse lock gets the rearm nudge; the
  orchestrator re-arms the leg. OS timers are retired — systemd/crontab
  installs no longer exist; install only strips the legacy entries
  they left.
- **Only orchestrators pulse.** Sessions with `BRO_AGENT_ID` set —
  spawned workers — never see the nudge and get refused by `bro pulse`,
  `bro review watch --every`, and `bro review drive --every`: recursion is
  how the watcher tree multiplies.
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
  decision surface; respawning is a manual act (`bro fleet agents up <step>`).
  The writes besides `--notify` drops are the heartbeat file (each
  tick's snapshot, atomically replaced) and the janitor: each tick
  reaps dead session/agent state under `<git-common>/bro/` (retention,
  not workflow) and reports it in the attention list.
- **Degraded is not dead.** A backend whose `list()` failed renders its
  rows `unknown`, never `lost` — don't respawn on a failed read.
- **Report progress in words, not IDs.** When relaying snapshot state
  to the user, translate every code: `bro-mol-3n2` → "the notify
  connector molecule", `bro-mol-0io` → "the `bro review watch` molecule".
  A status line must say what the agent is _doing_ and what just
  _landed_ ("PR for X merged, session moved to Y") — bare mol/bead/PR
  IDs alone are not a report. IDs may appear in parentheses.

## Watchdog tick (lane watch between turns)

When a session supervises a lane over long windows (rate walls, model
resets, queue refills), each inspection is a **bounded read-only tick** —
usually a subagent handed the brief below — that reports facts and never
acts. The session chains the ticks; the tick itself only reads.

**Read-only contract.** `bro`/`gh`/`ls`/`tail`/`ps`/`stat`/`find` and
`systemctl --user is-active|show` only. No kill, start, restart or
respawn — not even on a rate-limit: the tick says `RATE-LIMIT: park
(+reset …at HH:MM UTC)` quoting the reset time from the error text, and
the _operator_ acts. A spawn that died into a wall is normal
constatation, not a failure to fix.

**Anti-fabrication.** Every fact comes from command output produced
_this tick_ — never from memory or the previous report. Sync clocks once
per snapshot (`date -u` vs the `Date:` header of a `gh api` response).
Merges, PR states and counts come only from gh output. The window's
boundary is the timeout, not what the tick meant to see.

**PR counting and classification.** Count with `gh pr list --state open
--json number --limit 100 --jq 'length'` — the default limit (30) and
`gh api pulls` without `per_page` both undercount. Classify by
`headRefName`: `loop/*` and `fix/bro-*` are ours (the fleet), everything
else is foreign — report two numbers (fleet merges / total). A fleet
merge counts only from gh's merged state, corroborated by the loop log's
merge line — never from a branch disappearing.

**Baselines at tick start.** Record before waiting: the exit-file
boundary (`find <git-common>/bro/agents -name '*.exit' -newermt '<now>'`),
the PR count, and the supervisor pids/unit. Worker logs are append-only —
an old rate line is history; a fresh wall must be dated after the
worker's spawn. Liveness is the pidfile or unit, never a grep over `ps`:
`ps -p $(cat <git-common>/bro/loop.pid)`, `systemctl --user is-active
<loop-unit>`; a climbing `NRestarts` means the auto-restart is working —
constatation, not an alarm.

**Bounded wait.** Poll 60–90 s (8–10 min across a long reset window)
and stop at the first of: a new exit file (classify rate vs clean code),
PR count changed (re-verify with numbers + branches), a supervisor down,
a new spawn in the loop log, or the budget. Sleep past a reset to
boundary + 30 s instead of hopping every minute. Answer: `WAKE|TIMEOUT`,
lane state, wake reason, PR count (+classification), anomalies — then
the next tick's plan carrying the new baselines. Cap refusals, foreign
devin sessions, ETIMEDOUT and store-sync warnings are background — never
a wake.
