# bro-z8tng — `bro fleet delegate`: agent A activates agent B

## Problem

bro consumes ACP inward (conductor, judge) but has no agent-side
activation contract: a worker that needs another agent's help today has
only prose conventions. The 2026-10-16 architecture review flagged the
missing "agent A activates agent B" story. Two distinct needs exist and
they must share one contract:

- **Short asks** — "agent B, review this diff" — need a synchronous
  request/answer: one pooled ACP turn, text + provenance back, no
  registry entry, no worker, no claim.
- **Real work** — "agent B, implement X" — need a detached spawn: a
  registry entry, worktree, claim semantics, supervision — the same
  lifecycle `bro agents run` produces.

Without a shared contract every worker invents its own spawn (nohup,
argv prompts, untracked pids) — the exact failure the registry exists
to prevent.

## Design

### CLI: `bro fleet delegate`

```
bro fleet delegate [prompt…]
  --prompt <text>          literal prompt (positional equivalent)
  --prompt-file <file>     prompt from a file
  --provider <name>        providers.<name> pin (mutually exclusive with --class)
  --class <name>           fleet.routing lane — chain[0] supplies provider+model
  --model <m>              model override (wait: ACP config pin; detach: spawn spec)
  --wait                   sync ask (default) — one acpPooledTurn
  --detach                 registry spawn — returns agentId
  --timeout <sec>          --wait deadline (default 120)
  --connector <name>       --detach backend pin
  --worktree <path>        --detach worktree (default: minted <repo>--adhoc-*)
  --beads-dir <dir>        shared store override
  --auto-approve           --detach ACP permission policy
  --json                   result as JSON
```

`--wait`/`--detach` are mutually exclusive; detach-only flags
(`--connector`, `--worktree`, `--auto-approve`) and wait-only flags
(`--timeout`) error when combined with the wrong mode. Prompt resolves
exactly like `bro agents run`: positional words, `--prompt`, or
`--prompt-file` — never more than one source.

### Provider/class resolution — shared across both modes

`--provider` and `--class` are mutually exclusive. Resolution:

1. `--provider` → that `providers.<name>` entry.
2. `--class` or default → `resolveStepClass(fleet.routing, providers,
   {class})` — chain[0] supplies provider (+model when the chain pin is
   `provider/model`). `--class` without `fleet.routing` errors.
3. Neither and no routing → usage error (wait) / provider-optional
   spawn (detach, same as `bro agents run`).

Wait additionally requires the resolved entry `type === 'acp'` — a
pooled turn needs an ACP peer; `api`/`cli` kinds error with a clear
message.

### `--wait` — pooled turn

`acpOpen` a per-request peer (`delegate:<provider>`), `acpPooledTurn`
with `by: 'delegate'`, `requestModel: --model`, deadline =
now + `--timeout`. Wall check first: `providerWallsFor` refusing the
resolved provider fails `cap` before opening — a delegate turn is
automated spend, not an interactive lane. Peer closes in `finally`
plus an `exit` hook so a killed delegate cannot leak the ACP child.

Output: reply text on stdout; `--json` emits
`{mode:'wait', provider, model, class?, stopReason, text, delegatedBy?}`.

### `--detach` — registry spawn

`spawnStepAgent` with `molStep: adhoc-<8hex>` (the `bro agents run`
convention), prompt/promptFile, provider/model/class, connector,
worktree, autoApprove — the existing path supplies routing, walls,
`fleet.maxConcurrent`, session quotas, claims, and provenance for
free. `spec.env` carries `BRO_BATCH=1` (batch lane: wall-refusal,
batch budget) and `BRO_DELEGATED_BY=<agentId>` when known; `spec.delegatedBy`
stamps the registry entry and surfaces through `AgentInfo`.

Output: the same report as `bro agents run`; `--json` emits
`{mode:'detach', delegatedBy?, agent:{id,molStep,backend,state,pid?,
worktree?,log?,provider?,model?,class?}}`.

### Provenance

`BRO_AGENT_ID` of the caller (worker env pin) becomes `delegatedBy`
when unset by the caller (MCP args may declare it). New fields:
`SpawnSpec.delegatedBy`, `AgentRegistryEntry.delegatedBy`,
`AgentInfo.delegatedBy` — stamped centrally in `commitSpawn`, read in
`infoProvenance`, printed by `bro agents status` detail.

### Planes + MCP

The agents plane gains verb `delegate` (declared in `verbs`, wired in
`exec`, gated by `capabilities.delegate` = backends-ok OR any acp
provider). `exec('delegate', args)` maps JSON args onto the shared
`delegate()` core and returns the result doc — REST
`POST /api/v1/planes/agents/delegate` gets it free under serve.json
auth.

`PlaneDescriptor` gains optional `mcpVerbs: string[]` +
`verbArgs: Record<string, JSONSchema>` — an explicit allowlist of
verbs exposed as MCP tools (v1 write surface stays closed; this spec
assigns the first one). The tools catalog emits
`bro_<plane>_<verb>` with `verbArgs[verb]` as inputSchema when
`caps[verb] === true`; `callTool` dispatches it through `plane.exec`.
`bro_agents_delegate` is therefore a thin wrapper over the same core
the CLI runs — not a CLI subprocess.

Exec return type widens `Promise<PlaneRow | void>` → `Promise<unknown>`
(undeclared verbs still throw `PlaneVerbError`/`PlaneUnavailable`).

### Contract + docs

- `contract/cli.json` regenerated — plugin `contract.flags`/`exits`/
  `json` entries carry the flag and output schema.
- `skills/delegate/SKILL.md` — new skill (plugin convention:
  command + skill + config section).
- `skills/mcp/SKILL.md` — the "read-only in v1" note is amended:
  `bro_agents_delegate` is the one wired verb; other verbs remain
  reads-only.

## Verify

- `delegate.test.ts`:
  - wait path — `fakeAcpAgent()` through the `acp.peer` seam: prompt
    delivered, `{stopReason, text, model, provider}` JSON asserted,
    `--model` pin reaches `set_config_option`.
  - wait errors — non-acp provider, unrouted `--class`, missing
    provider, timeout flag misuse, exclusive flags, missing prompt.
  - detach path — native fixture spawn: registry entry exists with
    `molStep: adhoc-*`, `BRO_BATCH`/`BRO_DELEGATED_BY` env pins,
    `delegatedBy` on the entry; `--class` routes through a declared
    `fleet.routing` chain.
- `tools.test.ts` / `server.test.ts`: `bro_agents_delegate` appears in
  `tools/list` iff `caps.delegate`; `tools/call` dispatches to exec;
  unknown verbs still `PlaneVerbError`.
- `npm run gen:contract` + `npm run check:contract` — flag/output
  schema present.
- `npm test`, `npm run typecheck`, `npm run check:plugins`,
  `npm run check:embedded` — the real CI commands.
