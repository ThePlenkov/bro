---
title: Providers
description: The named provider registry — model-plane connections that judge and fleet consume by name.
---

A provider is a named entry in the `providers` section of
[`bro.config.json`](/docs/configuration#providers) — `{ type,
…connection }`. Consumers pick **by name**; the name carries no
semantics. The `type` fixes the connection shape and which surfaces the
entry can serve. There is no `bro providers` command — providers are
configured, and `bro doctor` reports the resolved set (a misnamed
`apiKeyEnv`, an unset env var, a bad model).

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

| kind | call ([judge](/docs/commands/judge)) | spawn (fleet) |
| ---- | ------------------------------------ | ------------- |
| `api` | by model wire — `systemone` typed, `openai-compat` prose | — |
| `acp` | typed on a `jev`-family model, else prose | yes |
| `cli` | prose — stdout parsed | yes — the `loop.agent` template contract |

- An `api` entry is a host + auth + a **`models` allowlist** —
  `{ "<model-id>": "systemone" | "openai-compat" | { "wire": … } | null }`.
  `null`/absent infers the wire: `jev`-family ids → `systemone`,
  everything else → `openai-compat`. `model` pins the default; a
  `judge.model` or per-call override must name an allowed id — anything
  else is a config error listing the allowlist. Auth is `apiKeyEnv`
  (the env var *name*) or `apiKeyCommand` (a secret-store lookup —
  the key never sits in the config file).
- `cli.command` is a shell template: `{promptFile}` expands to the
  quoted prompt-file path (appended as the last arg when absent),
  `{model}` to the resolved effective model. stdout is the answer. A
  model override the template can't consume is a loud error, not a
  relabel — provenance never claims a model the worker didn't run.
- An `acp` entry's call grade is decided by the served model —
  `typesafe/jev-*` (or bare `jev-*`) is typed transport; anything else
  is prose and stamps `provider:<name>:prose` in `decidedBy`.

## Consumer wiring

- **Judge** — `judge.provider: '<name>'` + `judge.model: '<allowed-id>'`
  (+ `judge.fallback: '<name>'`). The resolved model's wire picks the
  adapter. A prose-grade answer is never counted as a calibrated typed
  judgment — `decidedBy` says which.
- **Fleet** — `agents.<backend>.provider: '<name>'` or
  `fleet.profiles.<p>.provider` — the provider supplies what runs inside
  the backend's spawn; provenance rides `BRO_AGENT_PROVIDER` /
  `BRO_AGENT_MODEL` into the registry entry and `bro fleet` output.

No defaults, no hardcoding: absent `providers` means provider behavior
is off — a consumer naming a missing entry errors rather than silently
vendoring a fallback.
