# bro-d6k4v — loop work-order: commit+push checkpoint before deep verification

## Problem

The work-order prompt (`buildWorkPrompt` in `packages/loop/src/prompt.ts`)
orders the work as implement → verify like CI → commit+push+PR. An agent
that burns its turn budget or hits `loop.agentTimeoutMin` mid-verify dies
with commits sitting unpushed in the worktree — the loop keeps the
worktree for audit, but the work is invisible to GitHub and to any next
spawn.

Observed in the bro-rbqgf drill: the qem7d worker committed at 01:27 and
produced no visible PR for 8h — it survived only because it happened to
have pushed straight onto its PR branch. The prompt never asked it to.

## Design

Reorder the work-order rules so the durable checkpoint precedes the
expensive step:

- New rule directly after the AGENTS.md contract line: **checkpoint
  before deep verification** — as soon as the implementation lands,
  commit with a conventional message and push the branch; an end_turn or
  timeout must never orphan unpushed work. Verification fixes ride as
  follow-up commits on the same branch.
- The PR step (`gh pr create`, or `--base <member>` for stack members)
  stays last among the work rules and keeps its own `push, then`
  ordering, so post-verify fixes reach the branch before the PR opens.

`buildFixPrompt` and `buildRebasePrompt` are unchanged — they already
lead with push-is-the-verdict on a branch that exists upstream.

## Plan

- [ ] `buildWorkPrompt`: checkpoint rule ahead of the verify rule;
      `prLine` reduced to the `gh pr create` step (push re-asserted)
- [ ] test: work prompt orders the checkpoint before the verify rule

## Acceptance

- A worker killed mid-verification has its implementation already on the
  remote branch — recoverable by inspection or the next spawn instead of
  orphaned in a kept worktree.
