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
| Claude Code | repo root (`.claude-plugin/plugin.json` + `skills/`); hooks in `plugins/claude/bro/hooks/` |
| Codex | repo root (`plugin.json` + `skills/`); hooks in `plugins/codex/bro/hooks/` |
| Cursor | `plugins/cursor/bro` |
| OpenCode | `bro plugins install opencode` — native plugin + TUI module |
| Kilo | `bro plugins install kilo` — module + `kilo.json` registration |
| pi | `bro plugins install pi` — extension module |

Cursor installs from `.cursor-plugin/marketplace.json`. The adapter's
`hooks/hooks.json` uses Cursor event names; `bro hooks` translates that
stdin (`conversation_id`, `loop_count`, shell `command`) into the shared
contract and writes Cursor output (`additional_context`,
`followup_message`, `permission`). Cloud agents do not run `sessionStart`,
so the first `beforeSubmitPrompt` rehydrates once and `preCompact` clears
that mark. `stop` allows a single follow-up. A plain `bro` or `bd` command
is auto-approved even when the workspace has not opted in — an empty
permission reply would block the command — and a chained command stays a
prompt.

OpenCode loads the package's `./server` export rather than a shell-hook
manifest — `bro plugins install` materializes it (plus the TUI module)
into the client's plugin dir, globally under `$XDG_CONFIG_HOME` or
locally under `.opencode/plugins/`. Kilo and pi get the same treatment:
a module file in the client's extension dir, with Kilo's global install
also registered in `kilo.json`'s `plugin` array. All three use the same
bro hook bus; OpenCode has no pre-stop hook, so the first stop-gate
blocker is fed back as one synthetic prompt and later stop checks are
skipped rather than re-evaluated (`stop_hook_active`).

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
