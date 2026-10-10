---
name: agents
description: "Use when supervising bro-managed agents — respawn a lost worker, stop one, or check the agent plane across orchestrator connectors. Thin wrapper over `bro agents` — mechanics live in the CLI."
---

# /agents (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0` (major-pinned), plus
`bd` — `up <step>` claims and renders prompts through the shared beads
store.

`bro agents` is the supervisor surface over the orchestrator connectors
(native detached processes, gascity, tmux, …). The agentId registry in
the git common dir makes an agent's identity survive its process — a
respawn reuses the dead agent's id, worktree, and stored prompt.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro agents status [<id\|step>] [--json] [--connector <name>]` | The agent plane across every backend; an arg prints one agent's detail. Degraded backends warn — never a hard failure of the view, but a targeted miss exits non-zero when a backend is degraded ('gone' is only claimed on a healthy read) |
| `bro agents up [<step>] [--connector <name>]` | No arg: the backend's supervisor up (a `supervisor:'none'` backend like native is a reported no-op). With `<step>`: spawn the step's agent — a `lost`/`exited` agent is respawned on the same agentId (the beads claim rebinds), a live one is a SpawnError |
| `bro agents down [<id\|step>] [--connector <name>]` | No arg: supervisor down. With a target: stop that one agent — a gone agent exits 0 on a healthy read; a miss beside a degraded backend reports unverified (exit 1), not 'gone' |

`--connector <name>` scopes all three subcommands to one backend. Useful
flags on `up`: `--worktree <path>` (overrides the
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
- **Two caps, different axes.** `fleet.maxConcurrent` counts bro's own
  registry agents; `agents.<kind>.maxSessions` caps host-wide sessions
  through a registered session plane — `agents.devin.maxSessions`
  counts live devin CLI sessions (its `session_locks`, deduped by pid),
  interactive sessions included, so a spawn can refuse while the fleet
  looks empty. `agents.<kind>.maxWorkers` splits the count: only spawned
  workers fill it (devin: a `BRO_AGENT_ID` environ badge or a
  non-terminal stdin), so interactive TTYs stop starving rigs. A spawn
  counts into a kind when a registered plane detects the resolved
  command's CLI or the backend sets `agents.<backend>.sessionKind`; a
  declared kind with no registered plane refuses loudly. Devin's
  host-local count misses cloud-side `devin_session_create` sessions —
  a plane reports only what the host can verify.
