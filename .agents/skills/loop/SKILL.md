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

In `bro.config.json`:

```json
{
  "loop": {
    "agent": "devin --prompt-file {promptFile} -p",
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
`BRO_PROMPT_FILE`. Whatever permission flags your agent needs for
unattended work are yours to choose — e.g. devin's
`--permission-mode dangerous --respect-workspace-trust false` skips all
human confirmation, which is the point of the loop but obviously grants
the agent full autonomy; scope it to machines/repos you trust.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro loop` | Run the queue until idle or gated |
| `bro loop --max N` | At most N beads this run |
| `bro loop --dry-run` | Print the top item's plan (claim, worktree, agent cmd) — changes nothing |
| `bro loop --agent '<tpl>'` | One-off agent override |
| `bro loop --label a,b` | Declared scope — only beads carrying one of these labels are claimable; the rest of the shared queue stays untouched. "Loop the debt beads" never bleeds into unrelated work |
| `--agent-timeout MIN`, `--merge-timeout MIN`, `--interval SEC` | Budget overrides |

## What happens per bead

1. **Claim** — top `bd ready` item, `bro next`'s rules: HUMAN GATE beads,
   epics, and molecule steps (convoy-owned) are never auto-claimed.
2. **Worktree** — sibling `<repo>--<bead-id>` on branch `loop/<id>` off
   `origin/main`; `loop.bootstrap` runs once per bead, before the agent.
3. **Agent** — the work-order prompt is written to the worktree and the
   agent runs synchronously with `loop.agentTimeoutMin` budget. Its env
   pins `BEADS_DIR` to the runner's store (`bd where`), so `bd` writes
   inside the worktree reach the shared db regardless of version or a
   tracked `.beads` copy — and an agent `bd close` is honored as a
   verdict (`closed`), not reopened as a failure.
4. **Gate** — the PR is discovered via `gh pr list --head`; `bro act`'s
   gate is polled (`mergeTimeoutMin`). Green → `bro act merge` (merge
   slot + `--match-head-commit` apply). Threads → the agent is respawned
   with the thread list, up to `loop.fixRounds`.
5. **Close** — `bd close <id> --reason "landed via PR #N"`, worktree and
   branch removed, next bead claimed.

## Policy

- **The loop ends at `idle`, `gated`, or `--max N`** — `idle` means the
  backlog is empty; `gated` means only human gates / epics / molecule
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

## Done means verified-clean, not exited

A loop iteration is done only when the bead reached a terminal,
authoritatively verified state — PR `MERGED` per `gh pr view` and the
bead closed per `bd show`, or parked with a `loop:` note naming the
blocker. A process exiting is not a verdict.

The loop runs this audit itself at every exit — idle, gated, or error
(`try/finally` around the claim cycle): open `loop/*` PRs, surviving
`loop/*` worktrees and branches, beads still `in_progress`, and cleanup
failures collected during the run all print under `loop audit:` in the
run summary, then `bro sync` pushes artifacts and bead state. A clean
run prints `clean — no loop tails`. The audit is a report, not a fix —
listed tails still need a human or a follow-up session to clear.

Cleanup after a merge wait is `&&`-sequenced or command-owned — never
`;`: a failed `act wait` must not touch the PR, branch, worktree, or
bead.
