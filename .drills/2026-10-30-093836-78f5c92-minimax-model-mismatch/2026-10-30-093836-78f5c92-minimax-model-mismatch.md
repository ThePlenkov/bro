---

type: drill
id: 2026-10-30-093836-78f5c92-minimax-model-mismatch
parent: null
created_at: 2026-10-30T09:38:36Z
updated_at: 2026-10-30T10:30:00Z
status: resolved
agent: orchestrator
direction: down
sha: 78f5c92
slug: minimax-model-mismatch
goal: Find where bro routes the opencode model opencode-go/iceman-contributor-free into the omp-minimax ACP provider (causing "agent refused model") and why manual omp with its own default minimax-code/MiniMax-M3.1-Flash works; return the exact config/code spot + fix proposal + prevention plan.
scope: bro config layers, provider presets/routing code (fleet.routing, acp-worker --model plumbing), refusal log evidence, ~/.omp/logs for 2026-10-29/30, specs/bro-n1p0s.md. Read-only over the user's dirty main checkout (M packages/core/src/agents.ts, M index.ts are the user's active work — never touch).
problem: Fleet spawns through omp-minimax fail with "omp-minimax: agent refused model 'opencode-go/iceman-contributor-free'" (3x at 2026-10-30T04:03Z), and earlier "Still starting after 15s — phase: preloadPluginRoots" (exit 1, ~00:2x) after the first working spawn at ~00:22Z. Operator proves manual `omp` works: Default model minimax-code/MiniMax-M3.1-Flash (omp update 18.14.0 available, not required).
delegate: herdr-agent
trace: light
merge: summary
---

# Scope

In scope:
- Where the provider `omp-minimax` is declared. NOT in project `bro.config.json`, NOT in `~/.config/bro/config.json` (grep hit was a false positive inside `--prompt-file`); candidates: `bro.config.local.json`, `~/.config/bro/provider.env`, built-in presets in `packages/core/src/providers.ts`, fleet.routing defaults.
- How the model string reaches the worker: `bro acp-worker --command "omp acp" --model <model>` — where `<model>` comes from (SpawnSpec.model / provider entry / class routing `minimax=omp-minimax`).
- Refusal evidence: loop.out lines 04:03Z and `~/.omp/logs/omp.2026-10-30*.log`.
- `specs/bro-n1p0s.md` (the lane's spec) for intended model/provider contract.

Out of scope (hard constraints):
- NO live `omp acp` sessions / minimax quota spending without explicit operator GO — quota is precious and manual state is already proven working.
- NO writes to the main checkout (user's active worktree: `M packages/core/src/agents.ts`, `M packages/core/src/index.ts`, `?? specs/bro-n1p0s.md`, `?? drills/`, `?? .pi/`). Fixes only as a proposal or in a dedicated worktree.
- NO kill/restart of loop/daemon/workers; watchdog chain runs in parallel.

# Problem Statement

bro fleet's minimax lane spawns `omp acp` but passes the iceman (opencode) model; omp refuses it. Manual omp uses its correct default. Either the provider entry lacks its own `model`, or class routing substitutes the lane's default model for minimax.

Evidence (verified):
- `loop: acp-worker failed — acp provider 'omp-minimax' unavailable — omp-minimax: agent refused model 'opencode-go/iceman-contributor-free' — Internal error` ×3, 2026-10-30T04:03:27/39/49Z (native-e1773524, bead bro-n1p0s).
- `Still starting after 15s — phase: preloadPluginRoots`, exit 1, ~00:22-00:40Z (first omp spawn, attempt native-e1773524).
- Manual session: `Default model: minimax-code/MiniMax-M3.1-Flash`, ping works.
- Directive: minimax ONLY via official minimax.io (`minimax-code`), never opencode/anyrouter.

# Plan

1. **Pit A — model plumbing**: grep `omp-minimax` and `minimax` across `bro.config.local.json`, `~/.config/bro/*`, `packages/core/src/providers.ts`, routing code (`fleet.routing`, class→provider→model resolution), acp-worker `--model` construction. Produce the exact line that emits `opencode-go/iceman-contributor-free` for the minimax class.
2. **Pit B — timeline**: loop.out between 00:22Z (working) and 04:03Z (refusals): what changed (config edit? restart? provider preset?).
3. **Pit C — omp side (log-only)**: `~/.omp/logs/omp.2026-10-29*.log|2026-10-30*.log` around refusals; confirm server side refused the model string (vs rate/auth).

# Findings

Pit A — model plumbing (exact source):
- Declared profile `omp-minimax` exists in `bro.config.local.json` (`fleet.profiles.omp-minimax.model = "minimax-code/MiniMax-M3.1-Flash-Preview"`), and `fleet.routing.minimax.chain[0] = {provider: "omp-minimax"}` with NO inline `model` pin. Provider entry `providers.omp-minimax = {type: acp, command: "omp acp"}` has NO `model` field.
- Loop default profile is `loop.profile = "opencode-iceman"` (same file), whose profile carries `model = "opencode-go/iceman-contributor-free"`.
- In `packages/cli/src/commands/loop.ts` `lanePicks()` (lines ~476-494), `provider` resolves to `omp-minimax` via `route?.provider`, but `model` falls through:
  `sel.model ?? flagProfile?.model ?? (provider===route?.provider ? route.model : undefined) ?? cfgProfile?.model ?? ...`
  `route.model` is undefined (no pin), so the next term `cfgProfile?.model` (line 493) emits `opencode-go/iceman-contributor-free`. This is the exact line that emits the opencode model for the minimax class.
- `resolveSpawnProvider` (`packages/cli/src/agent-connectors.ts:362`) then does `model = sel.model ?? entry.model` = leaked value ?? undefined, and `acpWorkerArgv` (`packages/providers/src/acp.ts:1489`) pushes `--model opencode-go/iceman-contributor-free` to `omp acp`. Registry records `provider=omp-minimax, class=minimax, model=opencode-go/iceman-contributor-free` (`.git/bro/agents.json`, runId bf12fc1c).
- Same leak pattern in `packages/cli/src/commands/agents.ts:729-731` (`profile?.model` not guarded against `profile?.provider !== provider`).

Pit B — timeline:
- 2026-10-28: operator added minimax lane to `bro.config.local.json` and labeled bead `bro-n1p0s` `class:minimax` (comment "minimax ONLY via official minimax.io").
- 00:22Z 2026-10-30: manual omp session (`omp.2026-10-30.2087443.log`) ran with default `minimax-code/MiniMax-M3.1-Flash`-capable setup; not a fleet spawn.
- ~00:22-00:40Z: first omp spawn attempts hit "Still starting after 15s — phase: preloadPluginRoots" (exit 1) — omp cold-start/plugin preload, not model refusal.
- 04:03:27/39/49Z: loop spawned bead `bro-n1p0s` (class minimax) through `omp-minimax`; acp-worker passed the leaked model → 3× "agent refused model 'opencode-go/iceman-contributor-free'" (native-e1773524, runId bf12fc1c). Config itself did not change between 00:22 and 04:03; what changed was the bead being claimed by the minimax lane.

Pit C — omp side (log-only):
- `~/.omp/logs/omp.2026-10-30.379*.log` (05:03Z) contain only local provider discovery warnings (ollama/lm-studio/llama.cpp ECONNREFUSED) and one EPIPE on graceful shutdown; no minimax server-side refusal or auth error. The refusal is not a minimax.io auth/rate failure — it is omp rejecting the unknown model string before/while calling minimax. Confirmed by bro's own error: "omp-minimax: agent refused model 'opencode-go/iceman-contributor-free'".

## Verification (field proof, 2026-10-30T10:19:28Z)

Config safety-net applied by operator (providers.omp-minimax.model + routing pin) + loop restart; first minimax spawn records `provider=omp-minimax, class=minimax, model=minimax-code/MiniMax-M3.1-Flash-Preview` in agents.json (runId 212c6337, native-e1773524, real `omp acp` pid 2649405) — no iceman leak. Defense-in-depth code guard lands in fix/bro-mmmodel.

# Evidence

- Config: `bro.config.local.json` — `loop.profile = "opencode-iceman"`; `fleet.profiles.omp-minimax.model`; `fleet.routing.minimax` (no model pin); `providers.omp-minimax` (no model).
- Code: `packages/cli/src/commands/loop.ts:487-494` (lanePicks model fallback); `packages/cli/src/commands/agents.ts:729-731`; `packages/cli/src/agent-connectors.ts:362`; `packages/providers/src/acp.ts:1489`.
- Registry: `.git/bro/agents.json` entry `bro-n1p0s` → `native-e1773524`, provider `omp-minimax`, class `minimax`, model `opencode-go/iceman-contributor-free`, runId `bf12fc1c`.
- Log: `.git/bro/agents/native-e1773524.log` lines ~4508/4909/4911/4913: "acp-worker failed — acp provider 'omp-minimax' unavailable — ... agent refused model 'opencode-go/iceman-contributor-free'".
- omp logs: `~/.omp/logs/omp.2026-10-30.3797028.log`, `.3798631.log`, `.3799629.log` (only local discovery warnings); working manual session `omp.2026-10-30.2087443.log`.
- Bead: `bro-n1p0s` labels `class:minimax`.

# Links

- Specs: `specs/bro-n1p0s.md`
- Related: `.drills/2026-10-27-233304-4b7e19-hooks-quota-share`, `.drills/2026-10-28-102307-7c1a9d-hook-cmd-hang` (unrelated roots)

# Return Payload

Root cause: `packages/cli/src/commands/loop.ts:493` — `cfgProfile?.model` term in `lanePicks()` emits the loop's configured profile model (`opencode-go/iceman-contributor-free`, from `loop.profile = "opencode-iceman"`) for a routed `omp-minimax` lane whose `route.model` is undefined. Same unguarded `profile?.model` leak in `packages/cli/src/commands/agents.ts:730`.

Fix proposal (code, not applied — main checkout is user's active worktree):
1. Guard profile model against provider: in `lanePicks`, use `cfgProfile?.model` only when `cfgProfile?.provider === provider` (same for `flagProfile`). In `agents.ts`, `profile?.model` only when `profile?.provider === provider` (or provider undefined).
2. Add a default model to the provider entry: `providers.omp-minimax.model = "minimax-code/MiniMax-M3.1-Flash-Preview"` in `bro.config.local.json` (safety net so an undefined model still resolves).
3. Add inline pin to routing: `fleet.routing.minimax.chain[0] = {provider: "omp-minimax", model: "minimax-code/MiniMax-M3.1-Flash-Preview"}`.
4. Optionally set `fleet.profiles.omp-minimax` as the loop profile for minimax-class beads — but routing should carry its own model so it does not depend on loop.profile.

Prevention plan (see below).

# Prevention Plan

- action: Guard profile model against provider mismatch in lanePicks and agents spawn path
  scope: packages/cli/src/commands/loop.ts, packages/cli/src/commands/agents.ts
  sink: code
  owner: patcher
  evidence: unit test asserting a routed provider differing from the configured profile does not inherit the profile's model
- action: Add default model to omp-minimax provider entry and inline model pin to fleet.routing.minimax chain
  scope: bro.config.local.json (operator config, not committed)
  sink: code
  owner: operator
  evidence: `providers.omp-minimax.model` and `fleet.routing.minimax.chain[0].model` present; spawn records model=minimax-code/MiniMax-M3.1-Flash-Preview
- action: Add a spawn self-test for lane model/provider match (assert SpawnSpec.model belongs to the provider's model set or entry.model)
  scope: packages/cli/src/commands/loop.test.ts, packages/cli/src/agent-connectors.test.ts
  sink: code
  owner: patcher
  evidence: failing test before fix, green after
- action: Record minimax quota etiquette in memory (minimax ONLY via official minimax.io; never pass opencode/anyrouter models; never spawn live omp acp in drills)
  scope: persistent memory
  sink: memory
  owner: orchestrator
  evidence: ~/.agents/memory/experience/2026-10-30-minimax-quota-etiquette.md (PERSONAL operator layer — provider etiquette must not live in the repo; referenced by drill id 2026-10-30-093836-78f5c92-minimax-model-mismatch)
- action: Backlog item for routing refactor — make chain-head model pin mandatory or default to provider entry model when routing declares a provider
  scope: specs/bro-n1p0s.md / fleet.routing
  sink: backlog
  owner: architect
  evidence: bead created if routing refactor accepted

# Session Continuity

- **Agent**: herdr `minimax-drill` (kind opencode, sibling pane)
- **Role**: delegator = orchestrator session
