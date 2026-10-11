---
parent: sessions
scope:
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/session-planes/
  - packages/providers/
---

# bro-huy5o.9 — spike: cloud agent backends (claude headless, codex cloud, copilot coding agent)

Parent: `sessions` capability. See `spec.md` and `bro-f4ot/spec.md`.

Verdict: **GREEN — ship the GitHub Copilot coding agent (`gh agent-task`)
as the first cloud agent connector.** It is the only candidate that is
both genuinely remote and unblocked end-to-end, its artifact is a PR —
which the existing act gate already supervises — and it adds zero
binary prerequisites (`gh` is already the review-host dependency).
Claude Code headless is already served by the `cli`/`acp` provider kinds
— a connector buys it nothing; file a session-plane/preset bead instead.
Codex cloud is deferred: environment IDs are mintable only in the web
UI and cancel lives only in the private REST API.

## Capability matrix

Contract members from `bro-f4ot/spec.md` (`spawn`, `list`, `status`,
`stop`, `capabilities`) plus the two fleet concerns: **exit cause** (the
`.exit` record taxonomy) and **quota** (the `agents.<kind>.maxSessions`/
`maxWorkers` session plane).

| Contract | Claude Code headless / Agent SDK | Codex cloud tasks | Copilot coding agent |
| --- | --- | --- | --- |
| spawn | Local subprocess: `claude -p "<prompt>" --output-format stream-json --verbose`; `--model`, `--max-turns`, `--max-budget-usd`, `--permission-mode`, `--add-dir`; multi-turn via stream-json stdin; Agent SDK (`@anthropic-ai/claude-agent-sdk`, TS/Python) embeds the same. Cloud variant `claude --cloud` exists but rides a private `/v1/sessions` OAuth API — unstable. | `codex cloud exec --env <ENV_ID> "<prompt>" [--branch X] [--attempts 1-4]` → prints task URL. **ENV_ID provisioning is web-UI-only** (chatgpt.com/codex / TUI picker; no create/resolve CLI — openai/codex#24777). | `gh agent-task create "<prompt>" [--repo o/r] [--base b]` (gh ≥2.80.0, preview); REST `POST /agents/repos/{o}/{r}/tasks` (prompt, model, custom_agent, base_ref, create_pull_request); issue flow via `createIssue`/`replaceActorsForAssignable` + `agentAssignment` (needs `GraphQL-Features` headers). |
| status | Local: pid liveness; `session_id` in every envelope; `--resume`/`--continue`/`--fork-session`. Cloud: session URL, no public list API. | `codex cloud status <id>`; `codex cloud list [--env] --json` (limit ≤20, cursor). | `gh agent-task list`, `gh agent-task view <id\|pr#>`; REST `GET /agents/tasks/{id}` (task + sessions), repo-scoped `GET /agents/repos/{o}/{r}/tasks/{task_id}`. |
| exit cause | **Typed**: result envelope `type:"result"`, `subtype`: `success` / `error_max_turns` / `error_during_execution` / `error_max_budget_usd`; `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`. Richer than exit-code classification. | Task summary state machine (`TaskSummary`); `--attempts` best-of-N yields sibling attempts. Diff availability is the completion signal. | Session state via `view`; terminal artifact = pushed branch + optional PR — the PR then carries its own gate signal (checks, threads, SAST) through bro act. |
| logs | stream-json NDJSON (assistant/tool/result/`rate_limit_event`); on-disk transcript `~/.claude/projects/<dir-slug>/<session>.jsonl`. | No `logs` verb — `codex cloud diff` (final diff) + `apply`; messages via private client API only. | `gh agent-task view --log [--follow]` — live session log stream. |
| cancel | SIGTERM on the subprocess; SDK `interrupt()`. | **Not in the CLI** (exec/status/list/apply/diff only); private `POST /api/tasks/:id/cancel` is undocumented; web UI can stop. | **No CLI/REST cancel** — "Stop session" is web-UI-only; workaround: `gh run cancel` the backing Actions workflow run (discoverable from the session/PR check-runs). |
| quota | `--max-budget-usd` per-run cap + `--max-turns`; plan windows (Pro/Max) or API pay-per-token; `rate_limit_event` in-stream. Live count = pid-based plane (same /proc `BRO_AGENT_ID` probe as the devin plane). | ChatGPT plan task limits; `--attempts` multiplies. `list --json` can count in-flight tasks. | Premium requests per plan + Actions minutes; server-side session cap; **`GET /agents/tasks` enumerates account tasks — remote count for `agents.copilot.maxWorkers` is real**. |
| claim | Local worker in the worktree — standard on-behalf/native claim path. | Remote (OpenAI-managed container, server-side clone) — cannot reach the shared dolt; connector claims on behalf before dispatch. | Remote (GitHub Actions runner) — cannot reach the shared dolt; connector claims on behalf before dispatch. Steering via `@copilot` PR comments maps onto the act reply path. |

## Connector-fit read

- **Claude headless — no connector needed.** `spawn` is a local
  subprocess; `providers.<name>.type: cli` (`claude -p … < {promptFile}`)
  or `type: acp` (zed-industries `claude-code-acp` adapter) already runs
  it through the native backend today. What a dedicated backend would
  add — result-envelope exit causes, `--resume`, a pid session plane —
  is a *session-plane + preset* bead, not a connector. Filing as
  follow-up, not the recommendation.
- **Codex cloud — deferred.** The contract maps (`spawn`/`list`/`status`
  exist, `stop` degraded to private REST), but adoption-first fails at
  the first run: no scriptable way to mint or resolve an `ENV_ID`, so
  `bro agents up` cannot spawn until a human provisions the environment
  in a browser. Revisit when openai/codex#24777 ships
  (`codex cloud env list/resolve --repo`); also watch for a CLI `cancel`.
- **Copilot agent-task — recommended.** Full contract coverage:
  `spawn` = `gh agent-task create`; `list`/`status` = `agent-task
  list`/`view` + REST tasks endpoints (remote states map onto
  `AgentInfo.state`; gh failure → `degraded`, never `lost`); `logs` =
  `view --log`; `stop` = best-effort `gh run cancel` on the backing run
  then registry `stopped` (honest degradation — the one real gap);
  `capabilities` = `{attach: 'gh agent-task view --log --follow',
  respawn: create-new-task, supervisor: 'none'}` (GitHub hosts the
  runtime). `repoRoot` reads as `owner/repo` from the origin remote —
  no local worktree; the artifact is a remote-only `copilot/*` branch
  +PR, so `bro act` supervises it by number (`bro act wait <pr>
  --merge` armed at spawn off the registry entry's pinned `pr`).
  `bro drive` never sees it: its candidate set is local-only (worktree
  branches + `work/`/`loop/`/`stack/` local branches). A
  registry-sourced PR feed for drive is implementation-bead scope.

## Caveats carried into the implementation bead

- **Cancel is best-effort.** `stop()` must not promise teardown: cancel
  the Actions run when its id resolves, else mark `stopped` and surface
  the session URL for manual stop. A still-running cloud session is the
  documented failure mode, not a bug.
- **Enablement is a spawn-time gate.** Coding agent must be enabled
  (plan + org policy + Actions on). Probe cheaply and fail with a
  `SpawnError` naming the prerequisite — never a silent fallthrough.
- **Claim-before-dispatch is the integrity rule.** The remote worker
  cannot touch the shared dolt; the connector claims `molStep` into
  `beadsDir` *before* `agent-task create`, and pins `taskId`/PR into
  the `agents.json` entry. Same on-behalf pattern gascity uses.
- **Public-preview surface.** `gh agent-task` is a preview command
  (gh ≥2.80.0); pin REST endpoints as the primary plane where the CLI
  shape is thin (list/view already exist) and treat flag drift as a
  probe-failure, not a crash.
- **Quota plane is remote — and `countLive` is sync.** The live count
  comes from `GET /agents/tasks` filtered to in-progress, but
  `SessionPlane.countLive` is synchronous and runs inside the
  host-wide admission mutex: an awaited `fetch` cannot run there, and
  a blocking subprocess call stalls every plane's admissions behind
  one HTTP roundtrip. Implement it as a cached-count plane —
  `list`/`status`/`spawn` refresh a count file (the plane's own local
  state plane) and `countLive` reads it synchronously; an absent or
  stale cache fails closed (`unavailable`), same contract as the
  devin plane.

## Recommendation

Proceed with a `copilot` agent connector:

`spawn` = claim on behalf → `gh agent-task create "<prompt>" --repo
<origin> --base <default>` → registry entry `{taskId, pr?}`.
`status`/`list` = `agent-task view`/`list` + REST. `stop` = run-cancel
workaround + registry `stopped`. `capabilities.supervisor` = `'none'`.
`agents.copilot.maxWorkers` rides a remote-count session plane.

Follow-ups filed separately: claude/codex local headless as `cli`
provider presets + a claude session plane (envelope exit causes,
`--max-budget-usd`, resume); codex cloud when env provisioning is
scriptable.
