---

name: herdr-orchestrate
description: "Use when an agent orchestrates worker agents through Herdr — spawn an isolated worktree workspace per task, start any supported agent kind in it, brief it, wait on semantic state, verify the gate, tear down. Provider-agnostic: the mechanics are `herdr` CLI + git worktrees; any supported agent kind is an interchangeable worker. Covers the spawn sequence, blocking waits, label-vs-state semantics, sequential budget, and teardown order. In a bro-managed repo, spawn through `bro fleet agents`/`bro flow convoy` instead — this recipe is for herdr-only environments and herdr plugin internals."
---

# herdr-orchestrate — driving worker agents through Herdr

You are a fleet orchestrator. You drive worker agents through the Herdr
socket API (`herdr` CLI) over git worktrees. You never implement tasks
yourself — you spawn, brief, wait, verify, and tear down.

**Scope rule:** in a repo managed by `bro`, spawn through
`bro fleet agents` / `bro flow convoy run` — a raw `herdr agent start`
worker has no claim, no exit record, and runs outside the fleet cap and
`status`/`down` supervision. This recipe is for herdr-only environments
and for the herdr plugin's own internals.

All mechanics below are the verified `herdr` CLI surface. Placeholders:
`{{REPO_ROOT}}` main checkout, `{{TASK_ID}}` work item id (MUST match
`[a-z][a-z0-9-]{0,31}` — it lands in branch names, paths, and labels),
`{{SHORT_TITLE}}` human label (display surfaces only — never shell
strings), `{{AGENT_KIND}}` one of the kinds
`herdr agent start --kind` accepts (run `herdr agent` for the
installed list — it tracks the binary, not this doc),
`{{DONE_CRITERIA}}` the worker's gate — pushed commits + review
threads resolved + `bro review act status` reported (never just
"PR opened", and NOT "merged" — merge is the orchestrator's job,
see below), `{{PARALLEL_LIMIT}}` max concurrent workers.

**Merge ownership:** the worker never merges. It drives the PR to
gate-ready and reports the `act status` verdict; the ORCHESTRATOR
owns the merge — point-check the gate, arm
`bro review act wait <PR> --merge --cleanup --bead <id> --detach`
from inside the worktree (`--cleanup` retires the checkout it runs
in), and bounce new findings back to the worker instead of fixing
them yourself. The orchestrator outlives worker turns and watcher
timeouts — a worker-armed wait (45 min default) dies before a
CodeScene-length check cycle (~2 h) settles the gate, which is
exactly the split this rule exists to fix.

## Spawn one worker

1. Fresh base — always branch from current remote main:
   `git -C "{{REPO_ROOT}}" fetch origin main`.
   Do NOT `git pull` — the checkout may sit on a feature branch; you
   only need the fetched ref.
2. `herdr worktree create --cwd "{{REPO_ROOT}}" --branch "work/{{TASK_ID}}" --base origin/main --path "{{REPO_ROOT}}--{{TASK_ID}}" --label "{{TASK_ID}}"`
   → read `workspace_id` from `.result`. `--base` pins the source —
   without it the branch comes from the checkout's current HEAD.
   Every interpolated value MUST come from the validated set —
   `{{TASK_ID}}` is charset-constrained, paths are operator-owned.
   Never put `{{SHORT_TITLE}}` or any other free task text into the
   command string: it reaches the shell and a title containing
   command substitutions or backticks executes on the orchestrator.
   Quote every path expansion.
3. Get its shell pane: `herdr pane list --workspace <ws>` → pane_id.
4. `herdr agent start {{TASK_ID}}-worker --kind {{AGENT_KIND}} --pane <pane_id>`
   → the pane must be at an interactive shell prompt; success means the
   agent was detected in that terminal and is ready for input.
5. Write the brief to `{{REPO_ROOT}}--{{TASK_ID}}/{{TASK_ID}}-brief.md`
   with your own file-writing tool — the brief MUST state the GATE
   ({{DONE_CRITERIA}}), the worktree path, and "do not spawn
   sub-agents". Arm the persistent objective BEFORE the task prompt —
   the worker's first message must carry the goal, or a mid-run
   compaction drops the thread: worker kinds with a native `/goal` get
   `herdr agent prompt {{TASK_ID}}-worker "/goal {{DONE_CRITERIA}} — read {{TASK_ID}}-brief.md at the worktree root and execute it"`;
   for hosts without one, `bro work goal '{{DONE_CRITERIA}}'` run IN
   the worktree seeds it (materializes for the next session there —
   set it before `agent start`). Then submit a FIXED prompt string
   built only from validated placeholders:
   `herdr agent prompt {{TASK_ID}}-worker "Read {{TASK_ID}}-brief.md at the worktree root and execute it" --wait --until working`.
   Never interpolate the brief text itself into the prompt string —
   `herdr agent prompt` takes argv text, so any quote or substitution
   in free text executes on the orchestrator. `--wait --until working`
   confirms the turn actually started (`agent_prompt_stalled` if it
   didn't). Submission is rejected with `agent_blocked` if the agent
   is already waiting for input — read it first instead of re-prompting.
   If any step fails after the worktree exists, run the teardown below
   before retrying — a half-spawned workspace poisons the retry.

## Wait — never poll blindly

- `herdr agent wait {{TASK_ID}}-worker --timeout <ms>` blocks until the
  agent settles. Without `--until` it matches idle|done|blocked — use
  the default; an explicit list that omits `done` misses workers that
  finish unseen and waits forever.
- **A single `idle` is NOT proof of completion** — an agent idles
  between turns. Verify the GATE with an authoritative check (PR state,
  test result, artifact exists) before declaring done.
- `blocked` = the agent asks for input. `prompt` is rejected while
  blocked — answer via `herdr agent send-keys {{TASK_ID}}-worker`,
  then resume waiting.

## Semantics vs labels

- `agent_status` (idle|working|blocked|done) exists only while a LIVE
  process is bound to the pane. A dead pane silently drops status
  reports — never infer state from a dead pane.
- `herdr workspace rename <ws> "[status] title"` is the visible surface
  for dead or finished work — a marker, not truth.
- `unknown` on a pane means no live agent process bound — not a state
  to wait on unless you are probing for death.

## Teardown (in order, only after the GATE passes)

0. Confirm the worker is actually exited — `herdr agent list` shows no
   live binding for the name. A stale `[dead·]` label is a marker, not
   proof; never close a workspace whose worker is still live.
1. `herdr workspace close <ws>` — kills panes and agents.
2. Verify the agent is gone: `herdr agent list` — no entry for the name.
3. Verify the work is preserved — the GATE must prove it (merged PR,
   pushed commits). `git -C "{{REPO_ROOT}}" worktree remove "{{REPO_ROOT}}--{{TASK_ID}}"`.
4. `git -C "{{REPO_ROOT}}" branch -D "work/{{TASK_ID}}"` — check the
   remote ref first; a merged PR may already have deleted it.
   Skipping step 3's preservation check makes unmerged commits
   unreachable — branch `-D` discards them forever.

## Rules

- One task = one worktree = one worker. Two writers on one tree is a bug.
- Never hand-roll nohup/setsid workers — spawn through
  `herdr agent start` so every worker has a name, a status, and
  `wait` reach.
- Workspaces labeled `[dead·...]` whose branch has an open PR are
  paused work, not corpses — resume them in place, don't close them.
- Monitor by point checks (`herdr agent list`, `workspace list`), never
  by reading pane output in a loop.
- Respect `{{PARALLEL_LIMIT}}` — every worker spends the provider's
  global session budget, not just its own compute.
