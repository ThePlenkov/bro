# bro-c3no8 — loop spawns through the provider registry, not a raw sh template

## Problem

`bro loop --agent` accepts only a raw shell template. The provider
machinery (`providers.<name>` `type: acp`/`cli`, `fleet.profiles`,
`--provider`/`--profile`/`--model`/`--auto-approve` on `bro agents up`)
already exists and spawns `devin acp` as a headless stdio ACP server —
but loop bypasses it entirely. Consequence seen live: an unquoted
`--agent devin -p …` degraded into a bare interactive `devin` and opened
Devin IDE windows on the Windows side through WSL interop. ACP spawn is
headless by construction; the shell template is not.

`specs/sessions/bro-5hx1.1.md` shipped the spawn facade and explicitly
deferred this: "`bro loop` keeps its own spawnAgent path over
`loop.agent` — provider consumption does not reach it in v1." This bead
lands that consumption.

## Design

`bro loop` resolves an **agent lane** once at startup, before claiming
anything — a bad provider name is a config error that must not claim
and park beads. Two lanes:

- **Provider lane** — resolved through the same `resolveSpawnProvider`
  facade `bro agents up` and `bro drive` use (`agent-connectors.ts`).
  The resolved `SpawnWorker` replaces the template:
  - `acp` providers → an `argv` worker (`bro acp-worker --command …
    <promptFile>`). The loop runs the argv through the same
    `sh -c 'exec "$@"'` positional wrapper the native backend builds —
    `sh` resolves `argv[0]` on PATH — and awaits the exit code itself;
    the `.exit`-file wrapper exists only for detached registry spawns.
  - `cli` providers → a `template` worker — the provider's `command`
    substitutes for `loop.agent` and expands `{promptFile}` exactly as
    the legacy template does.
  - `api` providers have no spawn surface — `requireProviderSurface`'s
    `ProviderSurfaceError`, re-thrown by the facade as `SpawnError`.
    Loud, before claims.
- **Template lane** — `loop.agent` / a non-provider `--agent` value —
  unchanged: `sh -c` + `expandAgentCmd`.

### Naming a provider

The total order mirrors the facade's explicit → preset → backend ladder:

```
--provider <name>                    explicit flag
--agent <name>                     explicit flag — iff the value is a
                                   literal key of providers.<name>
loop.profile / --profile <name>    fleet.profiles preset (fills
                                   provider/model/autoApprove piecewise)
loop.provider                      config default
agents.native.provider             backend default (inside the facade)
loop.agent / --agent '<template>'  legacy escape hatch
```

A `--agent` value that exactly matches a configured `providers` key is a
provider name, not a template. A typo'd name still parses as a template
(today's behavior — the escape hatch cannot distinguish), so `--provider`
is the strict spelling: an unknown name fails `providers.<name> is not
configured`, exit 2.

`--model` and `--auto-approve` ride the provider lane only (model has no
wire in a raw template; auto-approve is an acp permission policy). A
`--model`/`--auto-approve`/`--provider`/`--profile` flag beside a
template `--agent` is contradictory input → exit 2. The same picks —
flags or `loop.model`/profile config — with no provider resolvable at
all → exit 2 (`--model/--auto-approve need a provider`).

A template `--agent` flag is the escape hatch: it replaces the whole
provider lane for that run, including a configured `loop.provider` —
one stderr line notes the bypass.

### Spawn shape

`spawnAgent` keeps its contract — synchronous, detached process group,
exit code to the caller. The `agentTimeoutMin` group-kill was removed
in bro-9lpn3 — a worker's lifetime is the orchestrator's call, made at
check-in, never a wall clock inside the spawn. The lane picks the
child:

- argv worker → `spawn('sh', ['-c', 'exec "$@"', 'loop-agent', …argv,
  promptFile])` — the same `"$@"` positional exec the native backend
  builds; the acp driver is headless by construction (spec
  bro-5hx1.1 §7).
- template worker / legacy → `spawn('sh', ['-c', expandAgentCmd(cmd,
  promptFile)])` where `cmd` is `worker.command` or the configured
  template.

Env pins stay identical (`BRO_BEAD_ID`, `BRO_BEAD_TITLE`,
`BRO_PROMPT_FILE`, `BEADS_DIR`) plus provenance: `BRO_AGENT` is the
worker's `cliName` (argv) or `commandCliName` of the effective command;
`BRO_AGENT_PROVIDER`/`BRO_AGENT_MODEL` pin the resolved provider lane,
matching `agentEnvPins` in the registry path.

The `{promptFile}` warning applies to the *effective* command — a cli
provider's `command` — and is skipped for argv workers (the prompt file
is a positional argv slot by contract, never a TUI trigger).

## Explicit non-goals (v1)

- **The agent registry / detached supervision** — the loop's spawn stays
  synchronous: the gate driver needs the agent *done* before polling the
  PR, and claim ownership already lives on the bead itself. No
  `agents.json` row, no fleet cap, no `.exit` record.
- **`fleet.routing` per-bead classes** — a bead's `class:` label picking
  a routed provider chain is bro-zmned's bead.
- **Session-plane quotas** — `agents.<cli>.maxSessions` admission
  (`sessionQuotaOf`) is not wired into the loop lane in v1.
- **Claim semantics** — `bro next`'s claim rules are untouched; the
  loop still claims the bead, so acp-worker provenance patches
  (`patchAgentRegistry` on `BRO_BEAD_ID`) stay advisory no-ops without
  a registry row.
