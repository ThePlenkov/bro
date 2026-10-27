---
title: Integrations
description: facades, connectors, agent clients, and hooks — what bro plugs into.
---

*Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`).*

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
`hooks/hooks.json` uses Cursor event names; `bro hooks` *(0.3.0)* translates that
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
- **Post-tool** drains the mailbox with `bro comms notify` and injects lessons
  matched by the tool trace.
- **Stop** contributes gate findings from the active connectors.

The hook runner owns the per-session arming policy. A connector reports
state; it does not decide whether ambient repository state should block this
session. Probes are bounded and fail-open, so a missing or wedged backend
does not wedge the agent.

### Capability matrix

Not every host can do everything — the matrix below is the declared
contract, enforced cell-by-cell against the shipped manifests and
adapters by `host-matrix.test.ts`. Bump `HOOK_MATRIX_VERSION` in
`packages/cli/src/host-matrix.ts` when any cell changes; the table here
is its rendering.

| bro event | Claude | Codex | Devin | Cursor | OpenCode | Kilo | pi | OMP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| session-start | `SessionStart` | `SessionStart` | `SessionStart` | `sessionStart` | `chat.system.transform` | `chat.system.transform` | `session_start` | `session_start` |
| post-compaction | — | `PostCompact` | `PostCompaction` | — | — | — | `session_compact` | `session_compact` |
| pre-compact | `PreCompact` | `PreCompact` | — | `preCompact` | `session.compacting` | — | `session_before_compact` | `session_before_compact` |
| prompt-submit | `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` | `chat.message` | `chat.system.transform` | `before_agent_start` | `before_agent_start` |
| post-tool | `PostToolUse` + `PostToolUseFailure` (`Bash`) | `PostToolUse` (`Bash`) | `PostToolUse` (`exec`) | `postToolUse` + `postToolUseFailure` (`Shell`) | `tool.execute.after` | — | `tool_result` | `tool_result` |
| pre-tool | `PreToolUse` (`Bash`) | `PreToolUse` (`Bash`) | — | — | `tool.execute.before` (V2) | — | — | `tool_call` |
| permission | — | `PermissionRequest` | `PermissionRequest` | `beforeShellExecution` | `permission.ask` | `permission.ask` | — | — |
| stop | `Stop` → **block** | `Stop` → **block** | `Stop` → **block** | `stop` → one follow-up | `session.idle` → re-prompt | `session.idle` → warn log | `agent_before_settle` → re-prompt | `session_stop` → **block** |

`—` is a declared gap: the host lacks the surface or bro deliberately
does not wire it (Claude's `PostCompact`/`PermissionRequest`, OMP's
permission plane, pi's block-only `tool_call`). Hosts that cannot halt
a stop turn bro's `decision:block` into UX — a follow-up prompt or a
log line — never enforcement.

**Post-tool outcome** is normalized per host: Claude splits success and
failure into two events; Devin sends `tool_response.success`; Cursor's
translator maps its split events; the extension adapters synthesize it
from `isError`; Codex cannot observe it (`PostToolUse` fires on
non-zero exits), so Codex arms on the hint and the journal records no
`ok`.

**Completion** is `sync` on the manifest hosts — `run.sh` blocks the
event, bounded by its timeout — and `async` on the extension/plugin
adapters, whose handlers resolve while work (a settle refresh, a
notification lane) continues in the background.

Three boundaries, stated once:

- **Advisory ≠ enforcement.** Nudges, context injection, re-prompts and
  toasts are UX. They are never a compliance or merge gate — the only
  enforced decisions are the ones a host's own `block`/`rewrite`/
  `approve` slots apply.
- **bro policy ≠ host permissions.** The stop gate and merge policy own
  *repo state* (markers, beads, PR gates). The host's permission plane
  stays the user's security surface; bro answers permission events, it
  does not widen them.
- **Opt-in approval is scoped.** The `approve` column approves only
  `bro`/`bd` self-tools — a workspace opting in to bro calling itself
  unprompted, not a statement about any other tool.

## The data ref

`bro work sync` keeps runtime artifacts outside the review surface on
`refs/bro/data`. Tracked source stays in branches; the data ref is for
untracked runtime state.
