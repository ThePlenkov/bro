---
name: providers
description: "Use when configuring or debugging bro's provider registry — `providers` in bro.config.json, provider kinds (api/acp/cli), model wire selection, `judge.provider` / `agents.<backend>.provider` references, or `bro doctor` provider rows. Mechanics live in the CLI + @broject/providers; this skill carries the contract and policy only."
---

# /providers (bro)

**Mechanics live in config and the `@broject/providers` bindings.** This
skill is the contract reference — providers are configured, never
hardcoded.

## What a provider is

A named entry in `bro.config.json` `providers` — `{ type, …connection }`.
Consumers pick **by name**; the name carries no semantics. The `type`
(provider kind) fixes the connection shape and which surfaces the entry
can serve.

```jsonc
{
  "providers": {
    // One API host, many models — each model declares its wire.
    "orcarouter": { "type": "api", "baseUrl": "https://api.orcarouter.ai",
                    "apiKeyCommand": "secret-tool lookup service typesafe.ai",
                    "models": {
                      "typesafe/jev-1.13": "systemone",
                      "acme/cheap-chat":   "openai-compat",
                      "acme/auto-x":       null          // inferred
                    } },
    "kilo-cli":   { "type": "acp", "command": "kilo --acp",
                    "model": "typesafe/jev-1.13" },
    "local":      { "type": "cli", "command": "devin -p --prompt-file {promptFile}",
                    "model": "devin-1" }
  }
}
```

## Kinds and surfaces

| kind  | call (judge)                                             | spawn (fleet)                      |
| ----- | -------------------------------------------------------- | ---------------------------------- |
| `api` | by model wire — `systemone` typed, `openai-compat` prose | —                                  |
| `acp` | typed on a `jev`-family model, else prose                | yes                                |
| `cli` | prose — stdout parsed                                    | yes — loop.agent template contract |

- An `api` entry is a host + auth + a **`models` allowlist** —
  `{ "<model-id>": "systemone" | "openai-compat" | { "wire": … } | null }`.
  `null`/absent infers the wire: `jev`-family ids → `systemone`,
  everything else → `openai-compat`. `model` pins the default;
  `judge.model` or a per-call override must name an allowed id —
  anything else is a config error listing the allowlist.
- `cli.command` is a shell template: `{promptFile}` expands to the
  quoted path of a file holding the prompt (appended as the last arg
  when absent); the process runs and exits, stdout is the answer.
- An `acp` entry's call grade is decided by the served model —
  `typesafe/jev-*` (or bare `jev-*`) is typed transport; anything else
  is prose and stamps `provider:<name>:prose` in `decidedBy`.

## Consumer wiring

- **Judge**: `judge.provider: '<name>'` + `judge.model: '<allowed-id>'`
  (+ `judge.fallback: '<name>'`). The resolved model's wire picks the
  adapter — `systemone` → typed judgments, `openai-compat` → prose.
  A prose-grade answer is never counted as a calibrated typed judgment —
  `decidedBy` says which. Legacy `judge.{baseUrl,model,apiKeyEnv}` /
  `judge.llm` synthesize anonymous single-model `api` entries with a
  deprecation warning.
- **Fleet**: `agents.<backend>.provider: '<name>'` or
  `fleet.profiles.<p>.provider` — the provider supplies what runs inside
  the backend's spawn; provenance rides `BRO_AGENT_PROVIDER` /
  `BRO_AGENT_MODEL` into the registry entry and `bro fleet` output.

## Non-negotiables

- **No defaults, no hardcoding.** Absent `providers` = provider behavior
  off, never a silent vendor. A consumer naming a missing entry errors
  at use — `providers.<name> is not configured` — never falls through.
- **Secrets ride env var names or lookup commands.** `apiKeyEnv` names
  the variable (SCREAMING_SNAKE); `apiKeyCommand` names a secret-store
  lookup (`secret-tool lookup …`, `pass show …`, `op read …`) whose
  stdout is the key. The key value never lands in config or error
  output — a command smuggling one inline is rejected.
- **Retired kinds fail the config.** `type: "systemone"` or
  `"openai-compat"` as a provider `type` is a hard error naming the
  migration — move the entry to `type: "api"` + `models` map.
- **Surface errors are config errors.** Asking an `api` entry to spawn,
  or a non-call kind to judge, fails at resolution naming kind + surface.
- **`bro doctor` reports the registry** — entries (name, kind,
  default/served models), unset `apiKeyEnv` vars, and
  dangling/surface-mismatched consumer refs, as warn rows that never
  block the exit code.

## Policy

- A new vendor is a **registry entry**, not a new connector — kinds
  exist for connection-shape differences only (the union is closed at
  three); protocol differences inside an HTTP host are `models` map
  entries, not kinds.
- Diagnose with `bro doctor` before touching provider config — a warn
  row there is the failure a spawn/decide would hit, said early.
