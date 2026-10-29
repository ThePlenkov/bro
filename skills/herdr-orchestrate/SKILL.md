---

name: herdr-orchestrate
description: "Use when an agent orchestrates worker agents through Herdr — spawn an isolated worktree workspace per task, start any supported agent kind in it, brief it, wait on semantic state, verify the gate, tear down. Provider-agnostic: the mechanics are `herdr` CLI + git worktrees; bro/devin/opencode/claude are interchangeable workers. Covers the spawn sequence, blocking waits, label-vs-state semantics, sequential budget, and teardown order."
---

# herdr-orchestrate — driving worker agents through Herdr

You are a fleet orchestrator. You drive worker agents through the Herdr
socket API (`herdr` CLI) over git worktrees. You never implement tasks
yourself — you spawn, brief, wait, verify, and tear down.

All mechanics below are the verified `herdr` CLI surface. Placeholders:
`{{REPO_ROOT}}` main checkout, `{{TASK_ID}}` work item id,
`{{SHORT_TITLE}}` human label, `{{AGENT_KIND}}` one of the kinds
`herdr agent start --kind` accepts (pi, claude, codex, gemini, cursor,
devin, agy, cline, omp, opencode, copilot, kimi, kiro, droid, amp, grok,
hermes, kilo, qodercli, qwen, letta, maki, muse),
`{{DONE_CRITERIA}}` the gate (e.g. "PR green + merged" — never
"PR opened"), `{{PARALLEL_LIMIT}}` max concurrent workers.

## Spawn one worker

1. Fresh base — always branch from current main:
   `git -C {{REPO_ROOT}} fetch && git -C {{REPO_ROOT}} pull --ff-only`.
   Stop on conflicts; never silently branch stale.
2. `herdr worktree create --cwd {{REPO_ROOT}} --branch work/{{TASK_ID}} --path {{REPO_ROOT}}--{{TASK_ID}} --label "{{TASK_ID}} {{SHORT_TITLE}}"`
   → returns the workspace_id bound to the new worktree.
3. Get its shell pane: `herdr pane list --workspace <ws>` → pane_id.
4. `herdr agent start {{TASK_ID}}-worker --kind {{AGENT_KIND}} --pane <pane_id>`
   → the pane must be at an interactive shell prompt; success means the
   agent was detected in that terminal and is ready for input.
5. Brief it: `herdr agent prompt {{TASK_ID}}-worker "<brief>"`.
   The brief MUST state the GATE ({{DONE_CRITERIA}}), the worktree path,
   and "do not spawn sub-agents". Submission is rejected with
   `agent_blocked` if the agent is already waiting for input — read it
   first instead of re-prompting.

## Wait — never poll blindly

- `herdr agent wait {{TASK_ID}}-worker --until idle --until blocked --timeout <ms>`
  blocks until the agent settles. Without `--until` it matches
  idle|done|blocked; add `--until unknown` explicitly if you mean to
  catch a dead binding.
- **A single `idle` is NOT proof of completion** — an agent idles
  between turns. Verify the GATE with an authoritative check (PR state,
  test result, artifact exists) before declaring done.
- `blocked` = the agent asks for input: `herdr agent read <name>`,
  answer via `herdr agent send-keys` or `prompt`, resume waiting.
- `herdr agent prompt --wait --until working` on submission confirms
  the turn actually started (`agent_prompt_stalled` if it didn't).

## Semantics vs labels

- `agent_status` (idle|working|blocked) exists only while a LIVE
  process is bound to the pane. A dead pane silently drops status
  reports — never infer state from a dead pane.
- `herdr workspace rename <ws> "[status] title"` is the visible surface
  for dead or finished work — a marker, not truth.
- `unknown` on a pane means no live agent process bound — not a state
  to wait on unless you are probing for death.

## Teardown (in order, only after the GATE passes)

1. `herdr workspace close <ws>` — kills panes and agents.
2. Verify the agent is gone: `herdr agent list` — no entry for the name.
3. `git -C {{REPO_ROOT}} worktree remove {{REPO_ROOT}}--{{TASK_ID}}`.
4. `git -C {{REPO_ROOT}} branch -D work/{{TASK_ID}}` — check the remote
   ref first; a merged PR may already have deleted it.

## Rules

- One task = one worktree = one worker. Two writers on one tree is a bug.
- Never hand-roll nohup/setsid workers — spawn through
  `herdr agent start` so every worker has a name, a status, and
  `wait` reach.
- Workspaces labeled `[dead·...]` are corpses — close them, don't reuse.
- Monitor by point checks (`herdr agent list`, `workspace list`), never
  by reading pane output in a loop.
- Respect `{{PARALLEL_LIMIT}}` — every worker spends the provider's
  global session budget, not just its own compute.
