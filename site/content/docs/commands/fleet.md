---
title: Fleet & supervision
description: Read the fleet, supervise agents, drive orphaned PRs, and expose a local web facade.
---

Fleet commands separate the read plane from the write plane. `bro fleet`
and `bro review watch` report what needs attention; `bro fleet agents` and `bro review drive`
take the deliberate actions.

## Fleet and agents

| Command | What it does |
| ------- | ------------ |
| `bro fleet` | One-shot rows for molecules, steps, agents, worktrees, and PRs |
| `bro fleet --json` | Machine-readable rows plus degraded-backend details |
| `bro fleet --live [--every N]` | TTY dashboard; `--every` changes the repaint cadence |
| `bro fleet agents status [<id\|step>] [--json] [--connector <name>]` | Read the agent plane or one agent |
| `bro fleet agents up [<step>] [--connector <name>]` | Bring up a supervisor or spawn/respawn a step |
| `bro fleet agents down [<id\|step>] [--connector <name>]` | Bring down a supervisor or stop one agent |
| `bro fleet agents prune [--connector <name>] [--older-than Nd] [--json]` | Reap terminal registry entries (exited, stopped, crashed); `blocked` stays — a wall-parked worker is still a worker |

The agents facade resolves native detached processes, tmux, and Gas City
backends. A lost or exited worker can be respawned with `bro fleet agents up
<step>`; the same `agentId` is preserved, and the recorded worktree and
stored prompt are reused when they still exist — otherwise it falls back
to the conventional `<repo>--<step>` worktree and the bead's own text.
`--worktree`, `--prompt-file`, and `--beads-dir` are available on `up`
when an override is needed.

Spawns can ride a named [provider](/docs/commands/providers) instead of
a backend's baked-in command: `--provider`, `--model`, `--profile` (a
`fleet.profiles.<name>` preset), and `--auto-approve` on `up`. Resolution
order is flag → profile → `agents.<backend>.provider` config. Provider
provenance (`BRO_AGENT_PROVIDER` / `BRO_AGENT_MODEL`) is recorded in the
registry entry and shown by `bro fleet` and `bro fleet agents status`.

Session kinds can carry host-wide admission quotas —
`agents.<kind>.maxSessions` caps live sessions of that kind across every
repo on the host (the devin plane is the known instance), and
`agents.<kind>.maxWorkers` caps only the *spawned* subset so the user's
interactive sessions never consume worker budget; admission claims a
slot file under a shared lock, and once the child lands its own
session mark takes over — leftover slot files are reaped on a ~120 s
TTL rather than released by `down`.

`--live` is a TTY dashboard and cannot be combined with `--json`. For a
non-interactive ticker, use `bro review watch --every N`.

## Watch and notify

| Command | What it does |
| ------- | ------------ |
| `bro review watch [--once]` | One read-only heartbeat with attention, molecules, gates, and fleet rows |
| `bro review watch --notify` | Drop the initial snapshot and transitions into the mailbox |
| `bro review watch --json` | Emit `{ts, attention, mols, gates, fleet}` |
| `bro review watch --every N --for S` | Repeat the heartbeat on a cadence — the unattended pulse leg: holds `bro/pulse.lock` (one per repo, a duplicate stands by) and refuses under `BRO_AGENT_ID`; `--for` bounds the window |
| `bro fleet pulse [S] [--no-notify\|--json] [-- <cmd>…]` | The session-owned metronome — a long-lived child that beats every S seconds (default `watch.intervalSec`): prints each tick and, as the `pulse.lock` holder, drops it into the mailbox — the mail IS the wake. A non-holder keeps ticking on stdout without mailing; refuses under `BRO_AGENT_ID`; `-- <cmd>…` ticks a probe command instead of the snapshot; works outside a repo as a pure timer |
| `bro review watch install [--every N] [--print]` | Arm the session pulse — writes `bro/pulse.json` (the want-marker session-start rearms from), strips any legacy systemd/cron entry; cadence `--every N` or `watch.intervalSec` (default 60) |
| `bro review watch uninstall` | Disarm the marker + strip any legacy timer/cron entry; a live pulse exits on its own |
| `bro comms notify <text>` | Write one mailbox event for live sessions — addressed drops, kinds, and the bus are in [Events](/docs/commands/events) |

Each tick also rewrites `<git-common>/bro/heartbeat.json` — the durable
last-known-state file (mailbox drops expire after ~1h; this file does
not), surfaced as the `watch:` row in `bro fleet status` and a session-start
context line.

Watch never claims steps, mutates beads, or respawns workers. Its attention
list is the decision surface; a `lost — respawn?` row is not permission to
spawn blindly, especially when a backend is degraded. The notify connector
drains unseen drops during the next post-tool probe, so a watcher can reach
the parent session without a wait loop.

Detach the watcher, don't block on it: `bro fleet pulse <S>` in a
background shell keeps a heartbeat running while the agent works — every
tick lands in the mailbox and surfaces in the session mid-turn, on its
next tool call (the mailbox is pull-based: a drop lands when the session
next acts, it never wakes a sleeping one — silence between beats is the
alarm). The session-pulse model is the durable form: `bro pulse` (or
`bro review watch install`) arms `bro/pulse.json`, and a session start
with no live pulse (lock holder dead) gets the rearm nudge — the
orchestrator re-arms `bro pulse`, and the unattended fallback is the
bounded `bro review watch --every N --for S --notify` the checkpoint
spawns (`--for` caps the window without tying the watcher to session
exit; the window's end is the wake event, followed by one
`bro review drive` pass, a digest, and the next window). OS timers are
retired — the session owns the cadence, and spawned workers
(`BRO_AGENT_ID`) never arm it.

## Drive

`bro review drive` is the write-side counterpart to watch. It walks open PRs on
fleet branches and uses the act gate to decide what happens:

| Gate state | Owner | Action |
| ---------- | ----- | ------ |
| `open_threads > 0` | occupied | Skip; the live owner keeps its work |
| `open_threads > 0` | orphaned | Spawn or respawn a fixer on the PR worktree |
| green | occupied, active | Report; the owner's merge step lands it |
| green | occupied, silent | Adopt as an orphan and merge — occupancy may hold a green PR back, never forever |
| green | orphaned | Merge through `bro review act merge`, retire clean work, close the fixer |

```text
bro review drive [--once] [--every [N]] [--no-merge] [--connector <name>] [--json]
```

`--once` is the default pass. `--every` is for a detached supervisor;
`--no-merge` supervises without merging. `--json` emits one verdict per
PR. The config section is `drive.intervalSec` (default `300`),
`drive.merge` (`auto`, the default, or `never`), and
`drive.occupancyTtlSec` (default `7200`) — the merge-path activity
bound: an occupied green PR whose owner shows no proven activity
(agent log mtime, marker stamp, worktree churn) inside the window is
adopted and merged, so a dead or silent owner never parks a green PR
forever.

The durable form is `bro review drive install [--every N] [--print]`: it
arms `<git-common>/bro/drive.json` — the want-marker — and brings the
supervisor up (`bro fleet daemon` owns the process). Orchestrator-session
checkpoints then rearm a dead supervisor on every lifecycle event —
spawned workers (`BRO_AGENT_ID`) never arm one — so the merge path is
always-on infrastructure, not an opt-in.
`bro review drive uninstall` disarms the marker and stops the
supervisor; `bro fleet daemon down` under an install is only a
transient stop — the next checkpoint brings it back. For a one-off
detached supervisor without the install, `bro fleet daemon up` spawns
the same loop by hand.

## Local service

`bro fleet serve [--port N]` hosts the fleet facade on loopback for thin
clients — see [status + serve](/docs/commands/status).

## Convoy fan-out

Several molecules are parallel work. Spawn workers detached, pin the
agent ID, PID, log, and claimed step, and monitor with point checks such as
`bro fleet agents status` or `bro fleet`. Never serialize the work in one
session and never wait in a blocking loop. Completion is detected from the
agent state and exit record, or from the claimed step closing; a process
disappearing is not proof that it finished.
