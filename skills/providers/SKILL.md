---
name: providers
description: "Use when configuring or debugging bro's provider registry — `providers` in bro.config.json, provider kinds (systemone/openai-compat/acp/cli), `judge.provider` / `agents.<backend>.provider` references, or `bro doctor` provider rows. Mechanics live in the CLI + @broject/providers; this skill carries the contract and policy only."
---

# /providers (bro)

**Mechanics live in config and the `@broject/providers` bindings.** This
skill is the contract reference — providers are configured, never
hardcoded.

## What a provider is

A named entry in `bro.config.json` `providers` — `{ type, …connection }`.
Consumers pick **by name**; the name carries no semantics. The `type`
(provider kind) fixes the wire protocol and which surfaces the entry can
serve.

```jsonc
{
  "providers": {
    "typesafe": { "type": "systemone", "apiKeyEnv": "TYPESAFE_API_KEY",
                  "model": "jev-1.13.0" },
    "orca":     { "type": "openai-compat", "baseUrl": "https://orca.example/v1",
                  "apiKeyEnv": "ORCA_API_KEY", "model": "qwen3-coder" },
    "kilo-cli": { "type": "acp", "command": "kilo --acp",
                  "model": "typesafe/jev-1.13" },
    "local":    { "type": "cli", "command": "devin -p --prompt-file {promptFile}",
                  "model": "devin-1" }
  }
}
```

## Kinds and surfaces

| kind            | call (judge)                              | spawn (fleet)                      |
| --------------- | ----------------------------------------- | ---------------------------------- |
| `systemone`     | typed — native judgments                  | —                                  |
| `openai-compat` | prose — prompt-and-parse                  | —                                  |
| `acp`           | typed on a `jev`-family model, else prose | yes                                |
| `cli`           | prose — stdout parsed                     | yes — loop.agent template contract |

- `cli.command` is a shell template: `{promptFile}` expands to the
  quoted path of a file holding the prompt (appended as the last arg
  when absent); the process runs and exits, stdout is the answer.
- An `acp` entry's call grade is decided by the served model —
  `typesafe/jev-*` (or bare `jev-*`) is typed transport; anything else
  is prose and stamps `provider:<name>:prose` in `decidedBy`.

## Consumer wiring

- **Judge**: `judge.provider: '<name>'` (+ `judge.fallback: '<name>'`,
  `judge.model` as a per-decision override). A prose-grade answer is
  never counted as a calibrated typed judgment — `decidedBy` says which.
  Legacy `judge.{baseUrl,model,apiKeyEnv}` / `judge.llm` synthesize
  anonymous `systemone` / `llm-judge` entries with a deprecation warning.
- **Fleet**: `agents.<backend>.provider: '<name>'` or
  `fleet.profiles.<p>.provider` — the provider supplies what runs inside
  the backend's spawn; provenance rides `BRO_AGENT_PROVIDER` /
  `BRO_AGENT_MODEL` into the registry entry and `bro fleet` output.

## Non-negotiables

- **No defaults, no hardcoding.** Absent `providers` = provider behavior
  off, never a silent vendor. A consumer naming a missing entry errors
  at use — `providers.<name> is not configured` — never falls through.
- **Secrets ride env var names only.** `apiKeyEnv` names the variable
  (SCREAMING_SNAKE) — the key value never lands in error output. A
  pasted key that happens to look SCREAMING_SNAKE passes `isEnvName`
  (indistinguishable from a name), which is exactly why messages name
  the config field and never echo the value.
- **Surface errors are config errors.** Asking a `systemone` entry to
  spawn, or a non-call kind to judge, fails at resolution naming
  kind + surface.
- **`bro doctor` reports the registry** — entries (name, kind, model),
  unset `apiKeyEnv` vars, and dangling/surface-mismatched consumer refs,
  as warn rows that never block the exit code.

## Policy

- A new vendor is a **registry entry**, not a new connector — kinds
  exist for protocol differences only (the union is closed at four).
- Diagnose with `bro doctor` before touching provider config — a warn
  row there is the failure a spawn/decide would hit, said early.
