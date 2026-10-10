---
name: status
description: "Use when a thin client (pi extension, TUI, dashboard) needs bro's live project board in one read — active beads, fleet workers, drill frame, PR gate. `bro status --json` is the contract; `--deep` adds the act gate (network). Requires `bro` (npx -y @broject/bro@0)."
---

# /status (bro)

**All mechanics live in the `bro` CLI.** This skill is the contract
reference for thin clients rendering the board.

## The read

```bash
bro status            # compact human board
bro status --json     # machine form — the thin-client contract
bro status --deep     # + act exit gate (gh calls — slower cadence)
```

`bro status` is the answer to "what is alive in this project right
now": one call instead of `bd list` + `bro agents status` +
`bro act status` per refresh tick.

```jsonc
{
  "dir": "/repo", "branch": "feat/x", "dirty": 3,
  "beads": { "inProgress": [{ "id": "bro-1", "title": "…",
                              "priority": 2, "assignee": "…" }],
             "ready": [{ "id": "bro-9", "title": "…" }],
             "readyTotal": 68 },
  "fleet": { "maxConcurrent": 3,
             "agents": [{ "id": "native-abc", "backend": "native",
                          "step": "bro-mol-x", "state": "running",
                          "cause": null, "pid": 123, "worktree": "bro",
                          "provider": "orcarouter", "model": "jev" }] },
  "drill": { "frame": { "id": "bro-x.1", "title": "…", "depth": 2 } },
  "watch": { "ts": "…", "ageMs": 240000, "attention": 0 },
  "act": { "pr": 282, "url": "https://…/pull/282", "gate": "BLOCKED",
           "openThreads": 2, "ciPending": 3,                        // --deep
           "blockers": ["3 pending check(s)"] }
}
```

## Contract notes

- **Read-only, cwd-scoped.** Never mutates; safe to poll on any tick.
- **Fast path is local-only.** `bd`, the agent registry
  (`<git-common>/bro/agents.json` — shared across linked worktrees),
  the drill stack, `git status --porcelain`. No network.
- **`--deep` adds `act`** — the current branch's open PR + exit gate
  (threads, checks, blockers). This is the network part; poll it on a
  slower cadence than the local board.
- **Absent state is empty, not an error.** Bead-less checkout → empty
  arrays; no registry → `agents: []`; no open PR → `act: null`; no
  heartbeat file → `watch: null`.
- **`watch` is the rig's heartbeat freshness** — read from
  `<git-common>/bro/heartbeat.json` (rewritten by every `bro watch`
  tick). `ageMs` is the signal: fresh = the timer is alive, stale = it
  died or was never installed. `attention` is the last snapshot's
  open-decision count.
- **Bead rows are slim.** Only `id`, `title`, `priority`,
  `issue_type`, `assignee` cross the wire — descriptions and
  dependency graphs stay in `bd show`. `beads.ready` is capped at 10;
  `readyTotal` carries the real count.
- **fleet.agents[].state** — `running | exited | stopped | unknown`,
  derived cheaply (pidAlive + recorded exitStatus), not the full
  connector probe `bro agents status` does.
