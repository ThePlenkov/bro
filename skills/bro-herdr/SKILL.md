---

name: bro-herdr
description: "Use when driving herdr devin sessions — sending a session a prompt, reading agent status, reporting agent state, or tearing a worktree down. The orchestration playbook: /goal-first prompts, composer-queue delivery, live-pane report binding, invisible metadata tokens, and the five-step teardown order."
---

# bro-herdr — the herdr orchestration playbook

Contract for any agent (bro or otherwise) orchestrating devin sessions
through the `herdr` CLI. The `herdr` skill owns command reference; this
playbook owns the five failure modes that silently lose work. Control
commands require `HERDR_ENV=1`.

## 1. `/goal` is a prompt position, not a prompt

Every prompt sent to a herdr devin session **begins with `/goal`** —
native goal-mode fires on the trigger at position zero, and any leading
prose (a greeting, a heading, even `Here is your task:`) makes it plain
text the session never parses as a goal.

The goal names the **completion gate**, never a milestone:

    /goal `bro review act status` reports exit_gate=OK and the PR is merged

`"open a PR"` is a step, not a gate — a goal of "PR open" ends the run
before review even starts. The gate is what `bro review act status`
declares, then the merge.

## 2. A busy pane queues — nothing delivers until CR

`send-keys` text to a pane already working lands in the session's
**composer queue**, not the conversation. It sits there until the
current turn ends. Two send modes, deliberately:

- **queue** — send the text without Enter; it waits for the running
  turn (status updates, next-step instructions).
- **immediate** — send the text followed by `send-keys <pane> C-m`
  (carriage return). The CR commits the queued text now.

Never assume a sent prompt was read. If the pane was busy and you
needed it handled, the delivery is the CR, not the text.

## 3. report-agent binds to a live pane, or it reports nothing

`report-agent` binds identity to a **live pane process**. The binding
is process-scoped: a dead pane (exited shell, killed tmux, closed
workspace) silently drops every report — no error, no queue, no
complaint. Verify the pane is live _before_ reporting, or the status
update vanishes.

Valid report states: **`idle` · `working` · `blocked` · `unknown`**.
There is no `done` — completion is asserted from the workspace/PR
gate (rule 1), never claimed as an agent state.

## 4. Metadata tokens are write-only — the label is the display

`report-metadata` tokens persist server-side but **the UI renders
nothing**. Do not rely on them for human-visible status. The visible
status surface is the **workspace label** — set status there (via the
label mechanism), in addition to the metadata, when a human needs to
see it. Metadata is for programmatic readers; the label is for people.

## 5. Teardown has one order — close, verify, worktree, branch, remote

1. **Close the workspace** — ends the panes; rule 3's binding dies here.
2. **Verify the agent is gone** — no live pane, no reportable process.
3. `git worktree remove <path>` — only after the agent that owned it is dead.
4. `git branch -D <branch>` — the worktree's branch, now unreferenced.
5. **Remote check** — `git ls-remote` / `gh pr list` for the branch and
   its PR: a pushed branch or an open PR means the close isn't clean.

Reordering (branch -D before worktree remove, remote check skipped)
leaves half-closed state that the next session trips on.
