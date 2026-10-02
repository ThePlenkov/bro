---
name: agents
description: "Use when supervising bro-managed agents — respawn a lost worker, stop one, or check the agent plane across orchestrator connectors. Thin wrapper over `bro agents` — mechanics live in the CLI."
---

# /agents (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro agents` is the supervisor surface over the orchestrator connectors
(native detached processes, gascity, tmux, …). The agentId registry in
the git common dir makes an agent's identity survive its process — a
respawn reuses the dead agent's id, worktree, and stored prompt.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro agents status [<id\|step>] [--json]` | The agent plane across every backend; an arg prints one agent's detail. Degraded backends warn — never a hard failure |
| `bro agents up [<step>]` | No arg: the backend's supervisor up (a `supervisor:'none'` backend like native is a reported no-op). With `<step>`: spawn the step's agent — a `lost`/`exited` agent is respawned on the same agentId (the beads claim rebinds), a live one is a SpawnError |
| `bro agents down [<id\|step>]` | No arg: supervisor down. With a target: stop that one agent — idempotent, a gone agent exits 0 |

Useful flags on `up`: `--connector`, `--worktree <path>` (overrides the
recorded/conventional `<repo>--<step>` lookup), `--prompt-file <file>`
(overrides the stored prompt / bead text), `--beads-dir <dir>`.

## Policy

- **Fleet first, agents second.** `bro fleet` is the read-only view —
  `lost — respawn?` rows are the decision surface; `bro agents up <step>`
  is the action behind it.
- **Respawn preserves identity.** Same agentId, same worktree, same
  stored prompt — a respawned fixer keeps its custom instructions. The
  claim in the shared beads store moves to the respawning actor.
- **Claims are the coordination plane.** A step claimed by a live agent
  refuses a second spawn; a claim held by another actor (or no agent at
  all) refuses a rebind — release the stale claim first, don't force it.
