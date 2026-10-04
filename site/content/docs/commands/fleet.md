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

The agents facade resolves native detached processes, tmux, and Gas City
backends. A lost or exited worker can be respawned with `bro agents up
<step>`; the same `agentId`, worktree, and stored prompt are preserved.
`--worktree`, `--prompt-file`, and `--beads-dir` are available on `up`
when an override is needed.

`--live` is a TTY dashboard and cannot be combined with `--json`. For a
non-interactive ticker, use `bro watch --every N`.

## Watch and notify

| Command | What it does |
| ------- | ------------ |
| `bro watch [--once]` | One read-only heartbeat with attention, molecules, gates, and fleet rows |
| `bro watch --every N` | Repeat the heartbeat on a cadence |
| `bro watch --notify` | Drop the initial snapshot and transitions into the mailbox |
| `bro watch --json` | Emit `{ts, attention, mols, gates, fleet}` |
| `bro notify <text>` | Write one mailbox event for live sessions |

Watch never claims steps, mutates beads, or respawns workers. Its attention
list is the decision surface; a `lost — respawn?` row is not permission to
spawn blindly, especially when a backend is degraded. The notify connector
drains unseen drops during the next post-tool probe, so a watcher can reach
the parent session without a wait loop.

## Drive

`bro drive` is the write-side counterpart to watch. It walks open PRs on
fleet branches and uses the act gate to decide what happens:

| Gate | Occupied? | Action |
| ---- | --------- | ------ |
| `open_threads > 0` | yes | Skip; the live owner keeps its work |
| `open_threads > 0` | no | Spawn or respawn a fixer on the PR worktree |
| `gate.ok` | yes | Report; the owner's merge step lands it |
| `gate.ok` | no | Merge through `bro act merge` when green, retire clean work, close the fixer |

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

`bro serve [--port N]` is a foreground, loopback-only HTTP/JSON facade.
It writes its discovery URL and session token to
`<git-common-dir>/bro/serve.json`. Reads are local; every mutation requires
`Authorization: Bearer <token>`.

| Route | Purpose |
| ----- | ------- |
| `GET /` | Service index |
| `GET /fleet` | Fleet web UI |
| `GET /api/v1/health` | Liveness |
| `GET /api/v1/snapshot` | Watch snapshot |
| `GET /api/v1/agents` | Agent plane |
| `GET /api/v1/agents/<ref>` | One agent by ID or molecule step |
| `POST /api/v1/agents` | Spawn an agent |
| `DELETE /api/v1/agents/<ref>` | Stop an agent |

## Convoy fan-out

Several molecules are parallel work. Spawn workers detached, pin the
agent ID, PID, log, and claimed step, and monitor with point checks such as
`bro agents status` or `bro fleet`. Never serialize the work in one
session and never wait in a blocking loop. Completion is detected from the
agent state and exit record, or from the claimed step closing; a process
disappearing is not proof that it finished.
