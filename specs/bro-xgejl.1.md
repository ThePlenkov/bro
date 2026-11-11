---
scope:
  - packages/providers/src/otel.ts
  - packages/providers/src/acp.ts
  - packages/providers/src/acp-worker.ts
  - packages/providers/src/otel-emit.test.ts
  - packages/providers/src/acp-worker.test.ts
  - packages/cli/src/agent-connectors/core.ts
  - packages/cli/src/agent-connectors.test.ts
  - packages/cli/src/commands/loop.ts
---

# bro-xgejl.1 — otel: identity enrichment — session/agent/model/cwd/repo/worktree/branch on every span

## Problem

Given any Tempo trace the operator cannot answer the plain questions:
which agent, which model, which cwd, which repo, which worktree, which
branch — and above all WHICH SESSION. Measured on trace
`0573c9be26efdf1172acd31b4a2c58b6`: the resource block carried only
`service.name=bro` + `service.version`, and none of the seven identity
dims were resolvable from span or resource attributes. The tree
machinery exists (`bro.cmd` root + ambient, `agent.spawn` +
TRACEPARENT injection at the `bro fleet agents up` spawn site,
`acp.open`/`acp.turn`/`acp.session` on the serve/conductor path), but
two legs emit nothing: `bro loop`'s spawn bypasses the
`agent.spawn`+TRACEPARENT site entirely, and the acp-worker driver
(`bro acp-worker` — the fleet worker itself) emits no `acp.*` spans at
all, so a fleet trace reads `bro.cmd hooks` roots with no
`agent.spawn`/`acp.*` chain.

## Design

### Resource identity — `packages/providers/src/otel.ts`

`resource()` — shared by every span body and every log record — gains
the identity dims, read live from env per emit (env is fixed at spawn
for workers; the reads are a handful of `process.env` lookups, cheaper
than the attribute array already built per call):

| resource attr         | env source                                     |
| --------------------- | ---------------------------------------------- |
| `bro.session.id`      | `BRO_SESSION_ID`                               |
| `bro.agent.id`        | `BRO_AGENT_ID`                                 |
| `bro.bead.id`         | `BRO_BEAD_ID` (fallback `BRO_BEAD`)            |
| `bro.agent.provider`  | `BRO_AGENT_PROVIDER` (fallback `BRO_PROVIDER`) |
| `bro.agent.model`     | `BRO_AGENT_MODEL` (fallback `BRO_MODEL`)       |
| `bro.worktree`        | `BRO_WORKTREE`                                 |
| `bro.branch`          | `BRO_BRANCH`                                   |
| `bro.repo`            | `BRO_REPO`                                     |
| `bro.cwd`             | `process.cwd()` — always                       |
| `service.instance.id` | `process.pid` — always                         |

The bead's env names (`BRO_BEAD`, `BRO_MODEL`, `BRO_PROVIDER`) read as
fallbacks behind the real pin names the connector already injects —
the pin contract wins, the aliases cost nothing. Unset dims are
absent, never `''`: a non-worker process (operator CLI, a hook outside
a worker) simply carries fewer attrs. `bro.*`-namespaced keys keep the
Tempo query obvious (`bro.session.id`) and collide with nothing.

### Spawn pins — `packages/cli/src/agent-connectors/core.ts`

`agentEnvPins` — the single funnel every local backend's env build
rides (native, tmux, gascity, docker) — appends the three dims only
the spawner can know:

- `BRO_WORKTREE` = resolved `spec.repoRoot`
- `BRO_BRANCH` = `git -C <repoRoot> branch --show-current` (absent on
  detached HEAD / non-git)
- `BRO_REPO` = `mainWorktreeRoot(repoRoot)` — the primary checkout,
  core's canonical anchor (handles `.git`-file worktrees,
  `--separate-git-dir`, bare layouts)

Probes run through a per-path memo (`worktreeTelemetryDims`, exported
for the loop's template arm): spawns are rare, the git reads are not
free, and `agentEnvPins` is called inside the native registry lock —
one probe pair per worktree per process is the whole cost. Fail-open:
a vanished or non-git worktree yields the dims it can prove. The three
keys join `AGENT_PIN_KEYS` — ambient and `spec.env` copies are
stripped like every other identity pin, so a parent worker's
worktree/branch can't bleed into a child spawn and a caller can't
forge them.

`isAllowedByEnvPolicy` gains one exemption: `TRACEPARENT` passes in
every mode (trace ids are plumbing, not credentials — an ambient copy
is also the correct parent for a nested spawn), and
`OTEL_EXPORTER_OTLP_ENDPOINT` passes from `spec.env` under `strictEnv`
(the spawner's explicit injection must survive or worker spans can
never join the parent's trace; ambient endpoint stays strict-gated as
today).

### Loop spawn sites — `packages/cli/src/commands/loop.ts`

Both loop spawn arms get the `agent.spawn` span + TRACEPARENT/
endpoint injection `spawnStepAgent` already performs (agents.ts:777) —
the fleet trace's missing middle:

- `spawnWorker` (registry path → `ctx.agents.spawn`): `agent.spawn`
  span `{agent.step, agent.backend, agent.provider, agent.model,
  agent.worktree, agent.branch?, agent.repo?}`; `TRACEPARENT` +
  `OTEL_EXPORTER_OTLP_ENDPOINT` ride `specEnv` into the connector's
  env build; span ends on the `AgentInfo` with `agent.id`/`agent.pid`/
  provenance — same end-attrs `spawnStepAgent` writes.
- `spawnAgent` (raw template arm → direct `sh -c`): same span shape
  (`agent.backend: 'template'`), `TRACEPARENT`/endpoint into the
  child env, span ends in `settle` covering the whole run
  (`agent.exit_code` on exit, error status on spawn failure). The env
  gains `BRO_WORKTREE`/`BRO_BRANCH`/`BRO_REPO` from
  `worktreeTelemetryDims(dir)` and `BRO_SESSION_ID` = the run's
  `agentId` when one exists (the connector's agentId-fallback
  semantics); `agentEnv` strips ambient copies of the new keys so a
  parent worker's dims can't bleed.

The acp-worker's agent-CLI child inherits the worker's env — the
`BRO_*` pins and `TRACEPARENT` reach every descendant (`devin acp`,
its `bro hooks` children) unchanged, so hook spans join the same
trace at the `agent.spawn` level. The child's env is fixed at spawn —
before `session/new` exists — so hooks parent under `agent.spawn`,
not the session span; same traceId either way, documented limit.

### acp-worker spans — `packages/providers/src/acp-worker.ts`

`runAcpWorker` — previously span-silent — now emits the same shape the
serve/conductor path does, parented off the ambient `bro.cmd
acp-worker` span (which itself joined `agent.spawn` via TRACEPARENT):

- `acp.open {acp.by, acp.command}` — child spawn + `initialize`;
  ends with `acp.pid` on success, error status on handshake failure.
  Its ctx is injected as the agent child's `TRACEPARENT` so the
  agent's own hook children nest under the open.
- `acp.turn {acp.by, acp.requested_model}` — parent `acp.open`;
  covers session/new → model pin → prompt pump → dispose.
- `acp.session {acp.by}` — parent `acp.turn`; `session/new` through
  turn end. Both end with `acp.session_id` (the ACP session id the
  registry records via `spec.record`) plus `acp.model`,
  `acp.stop_reason`, `acp.reply_len` on the turn — the "sessionId into
  acp.session" gap closed.
- `pumpTurn` gets `sessSpan.ctx` as its parent — the shared
  `tracedUpdates` wrapper then emits `acp.tool`/`acp.subagent` spans
  for free, same as every other pump caller.

`acpConverse`'s `acp.turn` end gains `acp.session_id` for parity with
`acpPooledTurn` (which already carries it) — one-line consistency,
same key.

## Non-goals

- No traceId derivation from session id — session id stays a
  searchable attribute (`bro.session.id` resource attr +
  `acp.session_id` span attr); "one session = one trace" remains doc
  intent, optional derivation later per the bead.
- No changes to the `packages/otel` hook facade — its OTLP sink rides
  `otelEvent`, which inherits `resource()` automatically.
- Remote backends (copilot) pin no local env — nothing to enrich.
- `acp.session.retain`'s `prompt()` turns stay span-silent (serve
  reuse path, outside the fleet-worker trace this bead targets).

## Acceptance

- For any trace of a fleet worker: all seven dims (session, agent,
  model, cwd, repo, worktree, branch) resolvable from resource/span
  attributes without reading code — `bro.session.id`, `bro.agent.id`,
  `bro.agent.model`, `bro.cwd`, `bro.repo`, `bro.worktree`,
  `bro.branch` on every span the worker emits.
- Tempo search by `bro.session.id` lists every span of that session
  (resource attrs are trace-wide in Tempo).
- Live chain: `bro.cmd <x>` → `agent.spawn` → `acp.open`/`acp.turn`/
  `acp.session` in ONE Tempo trace — verified locally via the OTLP
  loopback sink (span names, parent ids, resource attrs asserted in
  tests); the live-Tempo screenshot remains the operator's check.
