---

name: delegate
description: "Use when an agent needs another agent — ask a question synchronously or hand off real work. `bro fleet delegate` is the one contract: --wait is a pooled ACP turn for short asks, --detach a registry spawn for real work. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /delegate (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0` (major-pinned).

`bro fleet delegate` is the "agent A activates agent B" contract. One
command, two modes — pick by the shape of the work, not by taste:

| Mode               | What it is                                                                                                                                                        | Use for                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--wait` (default) | One pooled ACP turn against a `providers.<name>` **acp** entry — the reply text lands on stdout, `--json` adds `{provider, model, class?, stopReason}` provenance | Short asks: "review this diff", "summarize this log", "does this plan hold". Seconds-to-minutes, bounded by `--timeout` (default 120s)       |
| `--detach`         | The same registry spawn `bro agents run` takes — claim artifacts, worktree, `fleet.maxConcurrent`, session quotas, provider walls, supervision                    | Real work: "implement X", "fix the failing tests". Returns an `agentId`; completion is detected via `bro fleet agents status`, never awaited |

## Commands

| Command                                         | What it does                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `bro fleet delegate <prompt…> --wait`           | Ask another agent synchronously — reply on stdout                         |
| `bro fleet delegate --prompt-file <f> --detach` | Spawn a worker for the prompt file — prints `agent <id> <state> …`        |
| `bro fleet delegate … --provider <name>`        | Pin a `providers.<name>` entry (exclusive with `--class`)                 |
| `bro fleet delegate … --class <name>`           | Route through a `fleet.routing` lane — chain[0] supplies provider + model |
| `bro fleet delegate … --model <m>`              | Model override — wait-mode pins it on the ACP session                     |
| `bro fleet delegate … --json`                   | Machine-readable result — see the contract's `--json` schema              |

## Policy

- **Provenance is automatic.** Your `BRO_AGENT_ID` rides as
  `delegatedBy` on both modes — the detached worker gets it as the
  `BRO_DELEGATED_BY` env pin and a registry stamp (`bro fleet agents
  status <id>` shows who asked). "A spawned B" is always auditable.
- **Provider walls apply to both lanes.** A provider that killed
  workers with `rate_limited`/`quota` refuses a delegate call the same
  way it refuses a spawn — a delegate turn is automated spend, not the
  interactive lane. Retry after the reported `resetAt`, or route
  `--class` to a different chain.
- **Detach for anything you'd supervise.** If the ask needs a file to
  change, a PR to open, or longer than a `--timeout`, it is `--detach`
  work — never hold a `--wait` open as a cheap worker; the pooled turn
  is conversational, not a compute lease.
- **Never delegate recursively without thought.** The detached worker
  inherits the shared store and can delegate again — chain depth is
  your prompt's responsibility, not the tool's.
- **MCP:** the same contract is the `bro_agents_delegate` tool on the
  agents plane (`bro fleet mcp`/`bro mcp`) — identical args object,
  same core, same provenance.

## Exit codes

| Code | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | reply printed (`--wait`) or agent spawned (`--detach`)                             |
| 1    | provider walled/unavailable, spawn refused, or prompt/pin error                    |
| 2    | usage — `--wait`+`--detach`, `--provider`+`--class`, mode-foreign flags, no prompt |
