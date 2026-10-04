---
title: Integrations
description: facades, connectors, agent clients, and hooks — what bro plugs into.
---

bro keeps vendor details behind facades. Commands ask for tasks, reviews,
agents, or specs; the configured connector supplies the backend.

## Review hosts

### GitHub (`gh`)

The GitHub connector implements the `reviews` facade over authenticated
`gh`: PR state, threads, checks, and merge operations.

### GitLab (`glab`)

The GitLab connector implements the same `reviews` facade over authenticated
`glab`: merge-request state, threads, checks, and merge operations. GitLab
support is intentionally a review facade, not a claim that every GitHub
surface exists on GitLab. GitLab.com is detected from the origin remote;
self-hosted instances can be selected through `connectors.reviews`.

## Beads and the store

`bd` is the default task and memory backend. Drill frames, review debt,
retros, and work claims use the task facade; the JSONL ledger remains the
evidence record even when the beads projection is disabled.

## Agent clients

| Client | Adapter |
| ------ | ------- |
| Devin | `plugins/devin/bro` |
| Claude Code | `plugins/claude/bro` |
| Codex | `plugins/codex/bro` |
| OpenCode | native `@broject/bro` plugin |

OpenCode loads the package's `./server` export rather than a shell-hook
manifest. It uses the same bro hook bus, but OpenCode has no pre-stop hook:
the first stop-gate blocker is fed back as one synthetic prompt; later stop
checks are skipped rather than re-evaluated (`stop_hook_active`).

## Agent backends

The agents facade can resolve native detached processes, tmux, or Gas City.
Selection belongs under `connectors.agents`; backend knobs live under the
`agents` section. A respawn reuses the dead worker's agent ID, worktree, and
stored prompt.

## Sverka

`bro check` is the check facade. Sverka executes the repository workflow;
bro reports its steps and findings and mirrors its exit code. `--evaluate`
also collects SARIF artifacts and applies the Sverka policy gate.

## Hooks

Connectors contribute fail-open probes at lifecycle boundaries:

- **Session start** rehydrates state and injects matched lessons or SDD
  policy.
- **Parallel work** contributes a nudge when another live session owns work
  in the same repository.
- **Prompt submit** adds contextual policy and matched lessons.
- **Post-tool** drains the mailbox with `bro notify` and injects lessons
  matched by the tool trace.
- **Stop** contributes gate findings from the active connectors.

The hook runner owns the per-session arming policy. A connector reports
state; it does not decide whether ambient repository state should block this
session. Probes are bounded and fail-open, so a missing or wedged backend
does not wedge the agent.

## The data ref

`bro sync` keeps runtime artifacts outside the review surface on
`refs/bro/data`. Tracked source stays in branches; the data ref is for
untracked runtime state.
