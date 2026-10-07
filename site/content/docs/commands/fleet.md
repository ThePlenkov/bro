---
title: Fleet & supervision
description: Read the fleet, supervise agents, drive orphaned PRs, and expose a local web facade.
---

Fleet commands separate the read plane from the write plane. `bro fleet`
and `bro watch` report what needs attention; `bro agents` and `bro drive`
take the deliberate actions.

## Fleet and agents

| Command | What it does |
| ------- | ------------ |
| `bro fleet` | One-shot rows for molecules, steps, agents, worktrees, and PRs |
| `bro fleet --json` | Machine-readable rows plus degraded-backend details |
| `bro fleet --live [--every N]` | TTY dashboard; `--every` changes the repaint cadence |
| `bro agents status [<id\|step>] [--json] [--connector <name>]` | Read the agent plane or one agent |
| `bro agents up [<step>] [--connector <name>]` | Bring up a supervisor or spawn/respawn a step |
| `bro agents down [<id\|step>] [--connector <name>]` | Bring down a supervisor or stop one agent |
| `bro agents prune [--connector <name>] [--older-than Nd] [--json]` | Reap terminal registry entries (exited, stopped, crashed); `blocked` stays — a wall-parked worker is still a worker |

The agents facade resolves native detached processes, tmux, and Gas City
backends. A lost or exited worker can be respawned with `bro agents up
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
registry entry and shown by `bro fleet` and `bro agents status`.

Session kinds can carry a host-wide admission quota —
`agents.<kind>.maxSessions` caps live sessions of that kind across every
repo on the host (the devin plane is the known instance); the count is
admitted under a shared slot lock, and `down` releases the reservation.

`--live` is a TTY dashboard and cannot be combined with `--json`. For a
non-interactive ticker, use `bro watch --every N`.

## Watch and notify

| Command | What it does |
| ------- | ------------ |
| `bro watch [--once]` | One read-only heartbeat with attention, molecules, gates, and fleet rows |
| `bro watch --every N` | Repeat the heartbeat on a cadence |
| `bro watch --notify` | Drop the initial snapshot and transitions into the mailbox |
| `bro watch --json` | Emit `{ts, attention, mols, gates, fleet}` |
| `bro watch install [--every N] [--print]` | Install the heartbeat on a non-agent timer — a systemd user unit per repo (crontab fallback), cadence `watch.intervalSec` (default 60) |
| `bro watch uninstall` | Remove the installed timer/cron entry for this repo |
| `bro notify <text>` | Write one mailbox event for live sessions — addressed drops, kinds, and the bus are in [Events](/docs/commands/events) |

Watch never claims steps, mutates beads, or respawns workers. Its attention
list is the decision surface; a `lost — respawn?` row is not permission to
spawn blindly, especially when a backend is degraded. The notify connector
drains unseen drops during the next post-tool probe, so a watcher can reach
the parent session without a wait loop.

Detach the watcher, don't block on it: `bro watch --every N --notify` in a
background shell keeps a heartbeat running while the agent works — the
`--notify` drops surface in the parent session mid-turn, on its next tool
call (the mailbox is pull-based: a drop lands when the session next acts,
it never wakes a sleeping one). The same caveat as `act wait` applies — a
session-bound watcher dies with the session. When the heartbeat must
outlive it, `bro watch install` puts `--once --notify` on a non-agent
timer instead; `bro drive --every` is the durable write-side form.

## Drive

`bro drive` is the write-side counterpart to watch. It walks open PRs on
fleet branches and uses the act gate to decide what happens:

| Gate state | Owner | Action |
| ---------- | ----- | ------ |
| `open_threads > 0` | occupied | Skip; the live owner keeps its work |
| `open_threads > 0` | orphaned | Spawn or respawn a fixer on the PR worktree |
| green | occupied | Report; the owner's merge step lands it |
| green | orphaned | Merge through `bro act merge`, retire clean work, close the fixer |

```text
bro drive [--once] [--every [N]] [--no-merge] [--connector <name>] [--json]
```

`--once` is the default pass. `--every` is for a detached supervisor;
`--no-merge` supervises without merging. `--json` emits one verdict per
PR. The config section is `drive.intervalSec` (default `300`) and
`drive.merge` (`auto`, the default, or `never`).

Run a fleet driver detached, for example:

```bash
nohup bro drive --every 300 >> drive.log &
```

## Local service

`bro serve [--port N]` hosts the fleet facade on loopback for thin
clients — see [status + serve](/docs/commands/status).

## Convoy fan-out

Several molecules are parallel work. Spawn workers detached, pin the
agent ID, PID, log, and claimed step, and monitor with point checks such as
`bro agents status` or `bro fleet`. Never serialize the work in one
session and never wait in a blocking loop. Completion is detected from the
agent state and exit record, or from the claimed step closing; a process
disappearing is not proof that it finished.
