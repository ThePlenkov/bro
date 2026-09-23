---
name: loop
description: "Use when the user wants the backlog worked autonomously end-to-end — 'run the backlog', 'bro loop', a hands-off /goal over open beads. Unlike /next (one scheduling step), `bro loop` IS the loop: bro claims each ready bead, spawns the configured agent in a fresh worktree, drives the act gate, closes the bead, repeats. Requires `bro` and `bd`; the agent is configured via loop.agent."
---

# /loop (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.
`bro next` schedules one bead; `bro loop` runs the queue to exhaustion —
claim → worktree → agent → gate → close → repeat — with no per-item
"should I continue?" The backlog's existence is the approval.

## Configure the agent once

```json
// bro.config.json
{
  "loop": {
    "agent": "devin --prompt-file {promptFile} -p --permission-mode dangerous --respect-workspace-trust false",
    "bootstrap": "npm install",
    "agentTimeoutMin": 45,
    "mergeTimeoutMin": 45,
    "fixRounds": 3,
    "maxItems": 0
  }
}
```

`{promptFile}` is replaced with the work-order file bro writes into the
fresh worktree (no placeholder → the path is appended as the last arg).
Examples: `claude -p "$(cat {promptFile})"`, `codex exec "$(cat
{promptFile})"`. The spawn env carries `BRO_BEAD_ID`, `BRO_BEAD_TITLE`,
`BRO_PROMPT_FILE`.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro loop` | Run the queue until idle or gated |
| `bro loop --max N` | At most N beads this run |
| `bro loop --dry-run` | Print the top item's plan (claim, worktree, agent cmd) — changes nothing |
| `bro loop --agent '<tpl>'` | One-off agent override |
| `--agent-timeout MIN`, `--merge-timeout MIN`, `--interval SEC` | Budget overrides |

## What happens per bead

1. **Claim** — top `bd ready` item, `bro next`'s rules: HUMAN GATE beads,
   epics, and molecule steps (convoy-owned) are never auto-claimed.
2. **Worktree** — sibling `<repo>--<bead-id>` on branch `loop/<id>` off
   `origin/main`; `loop.bootstrap` runs once if configured.
3. **Agent** — the work-order prompt is written to the worktree and the
   agent runs synchronously with `loop.agentTimeoutMin` budget.
4. **Gate** — the PR is discovered via `gh pr list --head`; `bro act`'s
   gate is polled (`mergeTimeoutMin`). Green → `bro act merge` (merge
   slot + `--match-head-commit` apply). Threads → the agent is respawned
   with the thread list, up to `loop.fixRounds`.
5. **Close** — `bd close <id> --reason "landed via PR #N"`, worktree and
   branch removed, next bead claimed.

## Policy

- **The loop ends at `idle` or `gated`, not at a count** — `idle` means
  the backlog is empty; `gated` means only human gates / epics / molecule
  steps remain. Report which and stop.
- **Failures are visible, never silent** — an agent that exits without a
  PR gets the bead reopened with a `loop:` note; a stalled PR parks the
  bead with a note naming the blocker and the kept worktree path.
- **Already-attempted beads aren't re-picked** within a run — a reopened
  failure can't spin the loop forever.
- **`--dry-run` first on a new repo** — verify the agent template and
  worktree path before the loop starts claiming.
- One `bro loop` per repo — two runners would race the same top beads
  (claim is atomic, so the loser just takes the next one — wasteful,
  not corrupting).
