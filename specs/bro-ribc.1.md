---
parent: bro-ribc
scope:
  - packages/core/src/config.ts
  - packages/core/src/providers.ts
  - packages/providers/
  - packages/judge/
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/fleet.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/judge.ts
  - packages/cli/src/commands/doctor.ts
  - skills/providers/
---

# bro-ribc.1 — provider facade: one typed provider registry for judge and fleet

Parent: `bro-ribc` (epic). Pinning the design before children decompose.

## Problem

Today every consumer grows its own vendor plumbing. The judge has a
`systemone` connector and an `llm-judge` connector, with an `acp`
connector proposed (bro-4goa) — three codebases that each know how to
talk to "some model service". Fleet is about to grow the same thing
sideways: bro-5hx1 wants per-agent model selection and ACP-mode spawns,
which means agent connectors that *also* know about kilo, devin, and
their model flags. Two consumers, N vendors each, zero shared config —
and a credential/model detail fixed in one place never propagates to
the other.

The duplication is not in the *contract* — `JudgeFacade.decide()` and
`AgentConnector.spawn()` are already domain-shaped — it is in the
**provider knowledge**: base URL, auth env, model name, protocol kind.
That knowledge is identical whether the caller is judging a review
thread or spawning a worker. The fix is one typed registry: a named
entry says "this service, over this protocol, with this credential env
and this model"; consumers pick by name. Adding kilo to the registry
once makes it a judge backend *and* a fleet runtime in the same edit.

## Terms

- **provider** — a named entry in `bro.config.json` `providers`:
  `{ type, …connection }`. Names are user-chosen (`'typesafe'`,
  `'kilo-cli'`, `'orca'`, `'local'`); a name carries no semantics.
- **provider kind** — the `type` discriminant: `api`, `acp`, `cli`.
  The kind fixes the connection shape and which consumer surfaces the
  entry can serve — not the wire protocol.
- **wire** — the request/response protocol a *model* is served over:
  `systemone` (typed judgments) or `openai-compat` (chat-completions
  prose). Wire lives on the model, not the provider — one API host
  legitimately serves models over different protocols.
- **call surface** — request/answer inference: typed judgments
  (`decide`) or prose generation. Serves the judge.
- **spawn surface** — a session/process a worker lives inside. Serves
  the fleet. A provider kind may offer either, both, or one.
- **consumer contract** — the existing typed facade a consumer keeps:
  `JudgeFacade` for judge, `AgentConnector`/`SpawnSpec` for fleet.
  Providers sit *beneath* contracts; contracts never name vendors.

## Model

`providers` is a top-level core config section — a map, not a list,
because the consumer reference is `provider: '<name>'`:

```jsonc
{
  "providers": {
    "orcarouter": { "type": "api",
      "baseUrl": "https://api.orcarouter.ai",
      "apiKeyCommand": "secret-tool lookup service typesafe.ai",
      "models": {
        "typesafe/jev-1.13": "systemone",
        "acme/cheap-chat":   "openai-compat"
      } },
    "kilo-cli":   { "type": "acp",
      "command": "kilo --acp",
      "model": "typesafe/jev-1.13" },
    "local":      { "type": "cli", "command": "devin -p", "model": "devin-1" }
  }
}
```

Each kind's entry:

```ts
type ProviderEntry =
  | { type: 'api'; baseUrl: string; apiKeyEnv?: string;
      apiKeyCommand?: string; model?: string;
      models: Record<string, 'systemone' | 'openai-compat'> }
  | { type: 'acp'; command: string; profile?: string;
      model?: string; apiKeyEnv?: string; autoApprove?: boolean }
  | { type: 'cli'; command: string; model?: string }
```

Rules:

- **No defaults, no hardcoding.** The empty/absent `providers` section
  is a valid config — consumers fall back to today's behavior
  (judge's legacy config, fleet's `agents.<backend>.command` →
  `loop.agent`). Absence never *selects* a provider — the fallback is
  the existing connector-resolution path, which keeps its own explicit
  defaults; once `providers` exists, every consumer reference must
  resolve to an entry. A provider name that resolves to no entry is a
  startup error naming the missing key, never a silent fallthrough to
  a vendor the user didn't pick.
- **`type` is validated against known kinds**; an unknown type drops
  the entry with a warning (same policy as `connectors` section
  normalization). A dropped entry is indistinguishable from an absent
  one — a consumer referencing it gets the same startup error naming
  the missing key, so a typoed type fails at the same latency and with
  the same message shape as a typoed name (the drop warning carries
  the cause).
  Retired kinds (`systemone`, `openai-compat` as a `type`) fail the
  config with a migration line — they never silently parse.
- **Secrets ride env var names or commands** — `apiKeyEnv` names the
  variable (SCREAMING_SNAKE via `isEnvName`); `apiKeyCommand` names a
  secret-lookup command whose stdout is the key. Config never holds a
  value; a command smuggling one inline is rejected.
- **`models` is the allowlist** — an `api` entry serves only the model
  ids it declares, each mapped to its wire. A model value of a bare
  wire string, `{ "wire": … }`, or `null` (wire inferred: jev-family →
  `systemone`, else `openai-compat`) all parse; `{}` and
  `{ "wire": null }` are the object spellings of "infer". An object
  carrying other keys but no `wire` (`{ "wrie": … }` is a typo, not a
  pin) is malformed — it drops the entry rather than silently picking
  a wire. Asking for an undeclared model is a config error naming the
  allowlist — a router can never reroute a request to a model the
  config didn't admit.
- **`model` pins the default**; consumers may override per-call
  (`judge.model`, fleet per-profile) — the override must be in
  `models`, and it lands in provenance (`DecideResult.model`, the
  agent registry entry) so a verdict or a worker is always
  attributable to the model that ran it.

## Provider kinds

### `api` — one host serving models over model-level wires

An HTTP API host (`baseUrl` + `apiKeyEnv`/`apiKeyCommand`) serving a
declared set of models — each on its own wire protocol. This models
reality: a router like orcarouter is *one* provider, and the same
host serves `typesafe/jev-*` over `POST {baseUrl}/v1/systemone` while
chat models go over `POST {baseUrl}/v1/chat/completions`.
**Call surface only** — there is no session to spawn into.

The resolved model's wire selects the binding:

- `systemone` wire — typed decisions (`POST {baseUrl}/v1/systemone`,
  Bearer; wire contract pinned in
  `specs/sessions/bro-f4ot.2-judge.md`). Full fidelity:
  choice/score/noul + probabilities + confidence. SDK:
  `@typesafe-ai/sdk` 0.6.x or the raw-fetch client in
  `packages/judge/src/systemone.ts`.
- `openai-compat` wire — prose-grade chat completions. Answers are
  prompt-and-parsed under llm-judge semantics and `decidedBy` is
  marked honestly — never masquerading as calibrated typed judgments.
  An entry with no `apiKeyEnv`/`apiKeyCommand` calls the host
  unauthenticated: anonymous compat endpoints answer, a host that
  demands a key fails at call time with the auth error — loudly, in
  the same decide() surface as today's connectors.

### `acp` — an agent process speaking ACP

An Agent Client Protocol endpoint — a CLI that serves ACP over stdio
(`kilo --acp`, `devin -p --acp`, `gemini --acp`). **Both surfaces:**

- *Call*: the client spawns a minimal ACP session, posts
  `{state, questions}` as a prompt, expects judgments back. Two
  sub-modes, distinguished by the session's model: (a) the model IS a
  systemone-family model (`typesafe/jev-*`) — the prompt carries the
  typed contract and the reply content is validated against it: a
  payload that verifies keeps typed fidelity, an unparseable one fails
  open and is never counted as typed (an ACP prompt result is content,
  not a schema response — the model id selects the contract, not the
  wire format); (b) a general LLM — prompt-and-parse, flagged
  uncalibrated so `judge stats` never mixes it into the typed
  agreement matrix (bro-4goa's caveat, preserved).
- *Spawn*: a fleet worker IS an ACP session — the persistent form of
  the same connection, driven by the agent's own turn loop rather than
  a prompt file.

SDK: `@agentclientprotocol/sdk` (verified npm 2026-10-05 — 1.7.0,
Apache-2.0; the `zed-industries/agent-client-protocol` name is
deprecated upstream — renamed, not forked). Stable entry point is ACP
v1; the `/experimental/v2` import stays out of scope.

### `cli` — a bare command template

A one-shot command — today's `loop.agent` contract generalized:
`{promptFile}` expands like `expandAgentCmd`, the process runs the
prompt and exits. **Spawn surface** for fleet (the worker is the
process); for the judge it can serve as a prose call (prompt on
argv/stdin, judgment parsed from stdout) — the cheapest possible
backend, calibrated no better than llm-judge and marked accordingly.

### Capability matrix

| kind   | call (judge)                             | spawn (fleet) |
| ------ | ---------------------------------------- | ------------- |
| `api`  | by model wire — `systemone` → typed,     | —             |
|        | `openai-compat` → prose                  |               |
| `acp`  | typed if jev-model, else prose           | yes           |
| `cli`  | prose (stdout parse)                     | yes           |

A consumer asking a provider for a surface its kind doesn't have gets
a startup error naming kind + surface — `providers.local.type: 'cli'`
serving `judge.provider` is legal-but-prose; asking an `api` host to
spawn a fleet worker is a config error, not a runtime surprise.

## Consumer contracts

### Judge — `judge.provider`

```jsonc
{ "judge": { "provider": "kilo-cli", "confidence": 0.6,
             "fallback": "orca", "mode": "shadow" } }
```

`judge.provider` names a registry entry; the kind selects the adapter.
The served object is the unchanged `JudgeFacade` — `decide(state,
questions) → DecideResult`. What the provider changes is *who answers*:

- `decidedBy` carries `provider:<name>` (+ model), so stats scores each
  service on its own record and an acp-prose answer is never counted
  with jev's.
- `judge.fallback` names a second provider, not a connector — the
  chain's escalation semantics are unchanged.
- `judge.model`, when set, overrides the entry's `model` for decisions
  only — pinning for calibration stays a per-consumer concern.

**Compatibility** — `judge.baseUrl`/`judge.model`/`judge.apiKeyEnv`
synthesize an anonymous single-model `api` entry on the `systemone`
wire; `judge.llm` synthesizes one on `openai-compat`;
`connectors.judge: 'systemone'|'llm-judge'` resolve to those. A legacy
`judge.fallback` naming a connector resolves the same synthesized
entry, so an unmodified escalation config keeps working —
`judge.fallback` only *must* name a provider when `judge.provider` is
already set. A deprecation line prints once per command. Provider
*entries* get no such grace — `type: 'systemone'` or `type:
'openai-compat'` in `providers` is a hard config error with the
migration hint; the entry shape changed semantics (host + model
allowlist), so silent parsing would hide a real misconfiguration. New
configs only ever write `providers` + `judge.provider`/`judge.model`.

### Fleet — provider+model per profile

Fleet's seam is two words on `SpawnSpec`: which provider the worker
runs on, at which model — recorded on the registry entry and rendered
by `bro fleet`/`bro agents status` (this is the metadata bro-5hx1
needs; ACP-mode spawn mechanics are its child spec, bro-5hx1.1).

```jsonc
{ "agents": { "native": { "provider": "kilo-cli" } },
  "loop":    { "agent": "devin -p --prompt-file {promptFile}" } }
```

- A spawnable provider entry supplies the command/connection for the
  worker; `agents.<backend>.provider` overrides the backend's
  `command`/`loop.agent` template resolution — the backend still owns
  *where* the worker lives (native detached, tmux pane, gascity
  session), the provider owns *what* runs inside it.
- `model` from the provider entry (or a per-profile override) rides
  `SpawnSpec.env` as `BRO_AGENT_PROVIDER`/`BRO_AGENT_MODEL` and lands
  in the `AgentRegistryEntry` — provenance, so `bro fleet` can show a
  heterogeneous fleet truthfully and budget accounting can split cost
  by model. Both names join the protected `BRO_AGENT_*` pin set:
  connector-owned, filtered from caller `spec.env` — a plan must never
  re-badge a worker it merely describes.
- A provider that can't spawn (`api`) named on an agents config
  errors at `agents up`, not at list.

## Where it lives

```text
packages/core/src/providers.ts        ProviderEntry union, kind registry,
                                      capability matrix, validation errors
packages/core/src/config.ts           providers section (map, kind-validated,
                                      apiKeyEnv via isEnvName)
packages/providers/package.json       @broject/providers — SDK bindings live here
packages/providers/src/registry.ts    load providers → typed client per kind
packages/providers/src/systemone.ts   @typesafe-ai/sdk binding (typed answers)
packages/providers/src/openai.ts      @ai-sdk/openai-compatible / fetch binding
packages/providers/src/acp.ts         @agentclientprotocol/sdk client — call+spawn
packages/providers/src/cli.ts         command-template provider (spawn, prose call)
packages/judge/src/provider-judge.ts  JudgeFacade over a provider entry;
                                      llm-judge parse moves here for prose kinds
packages/cli/src/agent-connectors.ts  SpawnSpec + provider resolution for fleet
packages/cli/src/commands/fleet.ts    provider+model columns, --json fields
packages/cli/src/commands/doctor.ts   provider rows — entries, auth env,
                                      dangling/surface-mismatched refs
skills/providers/                     the providers skill (pack copy generated)
```

One new package because the SDK deps must be optional weight: a repo
without providers configured never pays for the ACP/ai-sdk imports —
`@broject/providers` is imported lazily by the consumers that resolve
an entry.

## Non-negotiables

- **Contracts stay vendor-blind.** `JudgeFacade`, `SpawnSpec`,
  `AgentConnector` name no provider type — kinds live below the seam.
  A new vendor is a registry entry (+ at most one kind file), never a
  new facade.
- **Honest fidelity.** A typed answer and a prompt-and-parsed answer
  are different grades of evidence; `decidedBy` must always say which
  produced it. Calibration theatre is worse than no annotation.
- **Selection is config, everywhere.** No code path may pick a
  provider or model the user didn't name — the "0 disables" precedent
  (fleet cap, act.maxRounds) applies: absent `providers` means absent
  provider behavior, not a default vendor.
- **Supersession, not duplication.** This replaces bro-4goa's shape:
  `acp` is a provider *type* consumed by judge and fleet alike — not a
  third judge connector. `llm-judge` dissolves into the
  `openai-compat` wire's judge adapter; `systemone` the connector
  becomes the `systemone` wire's adapter. Connector names survive only
  as compatibility aliases.
- **Provider ≠ protocol.** `systemone` and `openai-compat` are wires a
  model is served over, not provider kinds — a host is declared once
  and each served model picks its wire. The union of kinds is closed
  at three (`api`, `acp`, `cli`); a fourth kind is a spec discussion,
  not a PR.

## Milestones

1. `bro-ribc.1` this spec.
2. `providers` config section + `ProviderEntry` union + kind registry
   in core; validation, apiKeyEnv rules, capability matrix.
3. `@broject/providers` — systemone + openai-compat bindings; judge
   consumes `judge.provider`, legacy judge config synthesizes entries
   with deprecation warnings; `decidedBy` provenance lands.
4. `acp` kind — call surface first (minimal session → typed-or-prose
   judgment); spawn surface follows under bro-5hx1.1's spec.
5. Fleet consumption — `agents.<backend>.provider`, provenance fields
   on the registry entry, `bro fleet` renders provider+model.
6. `cli` kind + docs — `bro doctor` reports configured providers;
   skill + spec-drift wiring.

## Risks named up front

- **Kind proliferation.** The union is closed at three for a reason —
  the fourth kind is a spec discussion, not a PR. Kinds exist for
  *connection shape* differences (HTTP host vs. spawned process); wire
  protocol differences inside an HTTP host are model properties, not
  new kinds.
- **ACP drift.** The SDK is v1-stable with a draft v2 beside it; the
  provider pins v1 and the bead re-verifies at implementation time —
  a spec that hardcodes an experimental import rots on arrival.
- **Fidelity laundering.** The dangerous failure is a prose provider's
  parsed answer rendered like a typed one — `decidedBy` provenance is
  the control, and stats is the audit.
- **Config split-brain.** `judge.llm`, `connectors.judge`,
  `agents.<backend>.command`, and `providers` can all describe the
  same service — precedence must be total and documented: named
  provider > synthesized legacy > command template, every consumer the
  same.
- **Lazy-boundary leaks.** Core holds the *types* and the *registry
  config* — the SDK imports live in `@broject/providers` only; a
  `provider.ts` that imports the ACP SDK into core makes every `bro`
  invocation pay for a feature most repos never configure.
