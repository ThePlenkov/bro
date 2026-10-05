---
parent: bro-5hx1
scope:
  - packages/core/src/agents.ts
  - packages/core/src/config.ts
  - packages/core/src/providers.ts
  - packages/providers/src/acp.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/fleet.ts
  - packages/cli/src/commands/serve.ts
---

# bro-5hx1.1 — fleet-acp: a heterogeneous fleet through the provider registry

Parent: `bro-5hx1` (fleet agents via ACP + per-agent model selection).
Provider model and registry: `specs/bro-ribc.1.md` — this spec is the
spawn-surface half its milestone 5 explicitly defers to. Agents facade:
`specs/sessions/bro-f4ot/spec.md`.

## Problem

Every bro-managed worker is a command template: `agents.<backend>.command`
→ `loop.agent`, `{promptFile}`-expanded (`expandAgentCmd`), run under
`sh -c` detached, tmux-pane'd, or gc-sling'd. That shape can only express
"run this argv with a prompt file" — one runtime, one model, and no way
to say "this step runs on a cheap model, that one on a frontier model"
without forking the template per role.

The `providers` registry (bro-ribc.1) already names the services —
`{type: 'acp', command: 'kilo --acp', model: 'typesafe/jev-1.13'}` — but
nothing connects a fleet spawn to it. And the `acp` kind's spawn surface
is not a command template at all: ACP is a client-driven JSON-RPC session
over stdio. A detached `kilo --acp` with nobody holding the client end is
a dead process, not a worker — the spawn needs a driver, and the design
must answer where it lives, who owns its pid, and what happens to
permissions, models, and mid-turn death.

Missing the provenance half is its own bug: a heterogeneous fleet that
can't say *which* provider and model produced a run makes `bro fleet` a
liar and the budget taxonomy (bro-7xgk.3) unattributeable — "3 agents
live" is not a fleet when they cost different rates.

## Terms

- **spawn profile** — a named preset in `fleet.profiles.<name>`:
  `{provider, model?, backend?}`. The convoy/orchestration vocabulary for
  "sweeps go here, features go there" — `cheap` and `strong` are the
  shapes it exists for. Lives under `fleet` deliberately: `agents` is a
  `Record<backend, knobs>` (`agentsSection`) where a top-level
  `agents.profiles` key would parse as a phantom backend.
- **effective model** — the model a spawn actually runs: spawn override
  → profile's `model` → the provider entry's `model`. The resolved value,
  not the configured one, is what provenance records.
- **acp worker driver** — the client half of an ACP session, running as
  the registered worker process. The agent CLI is its stdio child; the
  driver is what `bro agents status` sees and `bro agents down` kills.
- **registry entry** — `AgentRegistryEntry` at
  `<git-common-dir>/bro/agents.json` — the durable handle behind
  `AgentInfo`.

## Provider consumption — one resolution seam

All spawn entry points already funnel through `spawnStepAgent`
(`packages/cli/src/commands/agents.ts`): `bro agents up <step>`, `bro
drive`'s fixer spawns, and `bro serve`'s `POST /api/v1/agents`. Provider
resolution lands there — a fleet consumed through one seam, not three.

```jsonc
{
  "providers": {
    "kilo-jev":  { "type": "acp", "command": "kilo --acp",
                   "model": "typesafe/jev-1.13" },
    "devin-cli": { "type": "cli", "command": "devin -p", "model": "swe-2" }
  },
  "agents": { "native": { "provider": "devin-cli" } },
  "fleet": {
    "profiles": {
      "cheap":  { "provider": "kilo-jev" },
      "strong": { "provider": "devin-cli", "model": "swe-2-high" }
    }
  }
}
```

`fleetSection` (`packages/core/src/config.ts`) gains a `profiles`
member — today it keeps only `maxConcurrent` and would normalize the
map away. A profile is `{provider: string, model?: string,
backend?: string, autoApprove?: boolean}`, validated the way every
config section is: non-object dropped, missing `provider` dropped
with a warning.

Selection surface (new — all optional):

```text
bro agents up <step> [--provider <name>] [--model <m>] [--profile <name>]
                     [--auto-approve]
```

`StepSpawnRequest` gains the same fields (`provider`, `model`,
`profile`, `autoApprove`), so serve and drive get the vocabulary for
free. `bro loop` keeps its own `spawnAgent` path over
`loop.agent` — provider consumption does not reach it in v1 (its contract
is the command template; a `cli`-kind entry could feed it later, which is
a follow-up, not a hole).

Precedence — total, same order every caller:

1. **explicit spawn fields** — `--provider`/`--model`/`--profile` (or the
   `StepSpawnRequest` fields). `--profile` expands to its preset's
   `provider`/`model`/`backend`; explicit `--provider`/`--model` beat the
   preset's values piecewise; a preset's `backend` redirects connector
   resolution only when `--connector` is absent.
2. **`agents.<backend>.provider`** — the backend's default provider.
3. **legacy template** — `agents.<backend>.command` → `loop.agent`.
   Reached only when no provider is named anywhere: today's behavior,
   unchanged.

Errors fail loud at `agents up`, never at `list`:

- a `provider`/`profile` name with no registry entry → startup error
  naming the key (bro-ribc.1's no-silent-fallthrough rule);
- a non-spawnable kind on the spawn path (`systemone`,
  `openai-compat`) → error naming kind + surface — the capability matrix
  is the contract;
- `cli` kind → the entry's `command` substitutes for the template and
  the existing one-shot mechanics apply verbatim;
- `acp` kind → the driver path below.

**The backend still owns *where*, the provider owns *what*.** An
`acp` provider on the `native` backend is still a detached process group
with a registry entry, a `.prompt.md`, a `.log`, a `.exit` — the backend
machinery (claim, dedup, fleet cap, kill) never learns what ACP is.

## SpawnSpec + provenance

`SpawnSpec` gains `provider?: string; model?: string` — **opaque labels**,
not types. The contract stays vendor-blind (bro-ribc.1's non-negotiable):
the connector records what the resolution layer computed and never
branches on it. Resolution — profile expansion, entry lookup, kind check
— all happens *before* `conn.spawn`, inside `spawnStepAgent` /
`agent-connectors.ts`; a backend receives an already-resolved spec.

Provenance lands in three places, all written in the same registry patch
the spawn makes (`prepareSpawn`'s `opts.entry` merge — provenance exists
even if the child process never starts):

- **`AgentRegistryEntry` / `AgentInfo`** gain `provider?: string` and
  `model?: string` — the registry entry name and the *effective* model.
- **Env pins** — `BRO_AGENT_PROVIDER` and `BRO_AGENT_MODEL` are injected
  when resolved and **join `AGENT_PIN_KEYS`**: connector-owned, filtered
  from caller `spec.env` like every identity pin. This answers bro-bq5i's
  open question — provenance a caller can forge is not provenance.
  `BRO_AGENT_MODEL` is already `MODEL_ENV[0]` for the `Agent-Model:`
  commit trailer (`githooks.ts`), so the pin closes the loop: commit →
  model attribution works the day a provider is named.
- **Fleet render** — `FleetRow` gains `provider`/`model`, rendered as
  columns (`—` when absent) and carried in `--json`; `bro agents status
  <id>` prints the same two lines. The fleet snapshot claims a
  heterogeneous fleet or it claims nothing — a row without provenance is
  a legacy spawn and says so by omission, honestly.

Budget accounting (bro-7xgk.3) reads the same fields later for
per-model cost splits — v1 records, it doesn't bucket.

## ACP spawn mechanics — the driver

An `acp` entry's spawn unit is a driver process, not the agent CLI:

```text
bro acp-worker --command '<entry.command>' [--model <m>]
               [--auto-approve] <promptFile>
```

The argv is rendered at spawn time, self-contained — a worker must not
depend on `bro.config.json` staying stable mid-run. `bro` resolves on
PATH with the `npx -y @broject/bro@0` fallback, the same contract the
hooks shim pins at install time. `entry.profile` (the `acp` union's
typed field, bro-ribc.1) renders onto the spawned command as
`--profile <value>` — the field exists so operators don't hand-edit
profile variants into `command`; a CLI that spells the flag
differently takes it inline in `command` and leaves `profile` unset.
The driver never parses the command — it receives the rendered string.

**Trust boundary, pinned.** `command` is operator-authored config — the
same trusted-code contract `loop.agent`/`agents.<backend>.command`
already carry (NOSONAR-documented `sh -c`); the driver does not
"sanitize" it because sanitizing a shell string is theatre. What the
spec forbids is *data* reaching the shell: the driver argv is built as
an argument ARRAY — `spawn(bro, ['acp-worker', '--command', command,
'--model', model, promptFile])`, never string-concatenated into one
`sh -c` line — so a `model` value carrying shell metachars (a
`StepSpawnRequest` field, reachable through `bro serve`) can't escape
its argv slot. Inside the driver only the trusted `command` string
meets `sh -c`; the prompt rides `session/prompt` params, never argv.

The driver's pid is the registry pid — one liveness story: detached →
own process group → `bro agents down` group-signals it exactly like a
template worker today, and the agent CLI dies with its driver.

Driver flow — ACP **v1** over `@agentclientprotocol/sdk` (1.7.0, verified
npm 2026-10-05; the deprecated `zed-industries/agent-client-protocol`
name and the `/experimental/v2` import stay out, per bro-ribc.1):

1. **spawn** `command` via `sh -c` as the stdio peer — the trusted
   config string only, per the trust boundary above (env:
   `process.env` + spec.env + the identity pins — the agent process
   sees the same badge set a template worker does).
2. **`initialize`** — `protocolVersion: 1`, `clientInfo` naming bro, and
   `clientCapabilities` with **fs and terminal advertised false**: v1
   grants the agent no client-side services — the CLI's own tool surface
   does the work. Serving fs/terminal requests is a separate spec, not a
   flag. If the response's `authMethods` is non-empty → startup error
   naming them: a detached worker cannot do interactive auth —
   credentials ride the agent CLI's own login/env.
3. **`session/new`** — `{cwd: spec.repoRoot, mcpServers: []}` →
   `sessionId` (+ advertised `configOptions`). MCP composition belongs to
   the agent CLI's own config, not the spawn.
4. **model** — when an effective model is set: find the session's
   `configOptions` entry with `category: "model"` and call
   `session/set_config_option {sessionId, configId, value: model}` —
   lookup is **by category, not a hardcoded `configId`** (ids are
   agent-defined). No model option advertised → **fail the spawn**
   naming provider + model: a requested model that silently doesn't
   apply is fidelity laundering, the same sin ribc.1 bans for judge
   answers. `session/set_model` is never called — it was unstable-only
   and removed from the protocol in 0.13.5 (2026-06); model selection
   lives in `set_config_option` on v1 *and* v2. No model requested →
   the session's `currentValue` stands and provenance records it when
   the option reports one.
5. **`session/prompt`** — the prompt file's text as one `text`
   ContentBlock (baseline-required content — no capability negotiation
   needed).
6. **`session/update` notifications → the `.log`.** One rendered line
   per update — the log stays the observability plane *and* the exit-
   cause classifier's input: provider walls (rate-limit/quota text the
   agent prints) must reach it or `classifyExitCause` reads 'crash'.
7. **`session/request_permission` → a defined policy field.** The
   `acp` entry union gains `autoApprove?: boolean` (this spec amends
   bro-ribc.1's union — the kind file owns the wire detail); a spawn
   override rides `StepSpawnRequest.autoApprove` / `--auto-approve` on
   `bro agents up`, and `fleet.profiles.<name>.autoApprove` names it in
   a preset. Resolution is the same ladder as `model`: spawn field →
   profile → entry → default **false**. Set → the driver answers with
   the allow option; unset → reject and log the denial. The honest
   consequence is documented, not softened: a headless worker against
   a permissions-asking agent stalls at the first request — the fix
   is the CLI's own auto-approve flag inside `entry.command`, or
   opting in.
8. **unadvertised agent→client calls** (fs, terminal) → JSON-RPC
   method-not-found, logged. Capability honesty beats partial
   emulation.
9. **SIGTERM/SIGINT on the driver** → `session/cancel`, a short grace,
   then the child group dies with it — the process-group kill is the
   backstop, cancellation is the courtesy.
10. **turn end** — the `session/prompt` response's `stopReason` maps to
    the driver's exit code: `end_turn` → 0; `max_tokens`,
    `max_turn_requests`, `refused`, `cancelled`, transport death, or a
    handshake failure → non-zero. The wrapper writes `.exit`, the log
    tail classifies the cause — every existing mechanic (respawn block
    on `rate_limited`/`quota`, `lost — respawn?`) works unchanged
    because the driver speaks the same artifacts.

`acpSessionId` lands on the registry entry (`opts.entry`) for debugging
— inspect-only, never a second handle.

**Respawn is a fresh `session/new`.** `session/load`/`resume` continuity
is deliberately out of v1: it's capability-gated per agent, and the
prompt file + beads state already carry the work order. Reattaching
history is a real feature — it earns a spec when a consumer needs it.

## Non-negotiables

- **Contracts stay vendor-blind.** `SpawnSpec`/`AgentInfo` carry
  `provider`/`model` as opaque strings; kinds live below the seam in the
  resolution layer. A backend never imports `@broject/providers` to
  interpret them.
- **Honest model application.** A named model that can't be applied
  fails the spawn — never silently runs the provider's default and
  records the wish. Provenance says what ran, or the spawn didn't happen.
- **Pin keys are connector-owned.** `BRO_AGENT_PROVIDER`/`BRO_AGENT_MODEL`
  join `AGENT_PIN_KEYS` — filtered from `spec.env` on every backend, one
  shared list (the boundary must not drift, same rule as today).
- **Absent providers = today's behavior.** No provider named anywhere →
  the legacy template path, unchanged. The "0 disables" precedent: bro
  never picks a vendor the user didn't name.
- **One liveness story.** The driver process is the registered worker;
  `agents down`, occupancy, and the fleet cap need no ACP awareness. A
  second pid namespace (agent pid vs driver pid) is the split-brain this
  refuses.
- **v1 wire only.** ACP v1 methods, stable config-option model
  selection. An agent that answers `initialize` with a version the SDK
  can't speak is a startup error, not a negotiation adventure.

## Filetree

```text
packages/core/src/agents.ts            SpawnSpec/AgentInfo/AgentRegistryEntry
                                       gain provider?/model?
packages/core/src/config.ts            fleetSection gains profiles; acp
                                       ProviderEntry gains autoApprove
packages/core/src/config.ts            fleetSection gains the profiles
                                       preset map — today it returns only
                                       maxConcurrent and would normalize
                                       the new half away
packages/core/src/providers.ts         spawn-surface capability check
                                       (kind → canSpawn), profile preset
                                       types, acp entry gains autoApprove?
packages/providers/src/acp.ts          spawn surface → driver argv builder
packages/providers/src/acp-worker.ts   the driver — initialize → session/new →
                                       set_config_option → prompt → updates
packages/cli/src/agent-connectors.ts   provider/profile resolution before
                                       conn.spawn; BRO_AGENT_PROVIDER/MODEL in
                                       AGENT_PIN_KEYS + agentEnvPins;
                                       provenance fields via opts.entry
packages/cli/src/commands/agents.ts    --provider/--model/--profile flags;
                                       StepSpawnRequest fields
packages/cli/src/commands/fleet.ts     provider/model columns + --json fields
packages/cli/src/commands/serve.ts     StepSpawnRequest fields pass through
```

## Milestones

1. `bro-5hx1.1` this spec.
2. Provider consumption — `agents.<backend>.provider`, `fleet.profiles`,
   the `--provider/--model/--profile` surface, registry + env-pin
   provenance — on the existing command-template path (`cli` kind
   included; `acp` resolution errors until .3). Fleet renders
   provider/model.
3. The ACP driver — `@broject/providers` acp-worker + `bro acp-worker` +
   the `native` backend's driver spawn path.
4. `tmux` backend on the driver path; `bro doctor` line for a configured
   acp provider whose `bro`/agent binary is missing.
5. Dogfood — one molecule on `profile: cheap`, one on `strong`; the
   fleet table shows both runtimes; attach the `bro fleet` output to the
   bead as the proof artifact.

## Risks named up front

- **Config-option id drift.** `category: "model"` is stable, but the
  option's `configId` and its legal `value`s are agent-defined — a model
  name an agent doesn't list may fail `set_config_option`. That failure
  is the honest error path working; the risk is agents that accept any
  value silently and run something else. The driver records the
  `config_option_update`/currentValue it observed into provenance when
  available — what the agent *said* it set, not what was asked.
- **Permission stall.** Default-deny plus a permissions-asking agent =
  a worker that does nothing, slowly. Logged denials make it visible;
  the mitigation is documented (`command` carries the CLI's own flag),
  not a permissive default — an unattended `allow` by default is a
  bigger hole than a stalled worker.
- **Driver liveness ≠ agent liveness.** A wedged agent process behind a
  healthy driver reads 'running'. Acceptable in v1 (log growth is the
  tell, `down` still kills cleanly); a turn-level heartbeat watchdog is
  the follow-up if dogfood shows silent wedges.
- **`bro` must exist in the spawned env.** The driver is `bro` itself —
  PATH-first, `npx` fallback. A repo whose spawned env strips both is a
  startup error with a clear message, same class as a missing `bd`.
- **ACP agent crash mid-turn** surfaces as transport death → non-zero
  exit → the existing cause ladder. Works *because* the driver owns the
  artifacts — the failure mode this spec must not regress is the log
  tail carrying the provider's real error text.
