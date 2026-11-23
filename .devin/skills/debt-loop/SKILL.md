---

name: debt-loop
description: Work the collected review debt end-to-end — group open ledger rows by area, fix each group on its own worktree+branch, open one PR per group, then land every PR serially through the gated `bro merge`. Run via run_workflow with this directory's workflow.py.
---

# debt-loop

Devin dynamic workflow that drives `bro debt` rows to merged PRs.

## When to use

- After `bro debt collect` produced open ledger rows you want fixed in bulk.
- The user asks to "work the debt", "loop the review debt", or close harvested
  review findings across merged PRs.

## How it works

`workflow.py` (run via `run_workflow`, `script_path` = this file's path):

1. **Inventory** — enumerates open rows from
   `.agents/review-debt/harvests/*.jsonl` and groups them:
   site/src, infra (scripts + cli/core threads), code-scanning, dependabot,
   stale-prs (triage-only).
2. **fix phase** — one shared-VM lite agent per group, each in its own git
   worktree under `<repo>-worktrees/debt-<slug>`: applies the findings,
   verifies locally (build, typecheck, `npm run check:codescene` where gated),
   pushes the branch and opens ONE PR via `gh pr create`.
3. **triage phase** — read-only verdicts for stale PRs.
4. **land phase** — one agent merges every opened PR serially with
   `node packages/cli/dist/index.js merge <PR>` (full gate: all threads
   resolved + CI green; never force-merges) and marks ledger rows done.

## Notes

- Agents run shared-VM on the orchestrator's machine and bill to its session.
  Keep concurrency as grouped here — do not fan out per-row.
- Requires the repo checked out locally, `gh` authenticated, and bro built
  (`npm run build`) — the land phase builds it itself if needed.
