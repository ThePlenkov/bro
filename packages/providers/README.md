# @broject/providers

[![npm](https://img.shields.io/npm/v/@broject/providers)](https://www.npmjs.com/package/@broject/providers)

The provider bindings behind the `providers` registry — `api`,
`acp`, and `cli` kinds, model-wire selection (`systemone` typed,
`openai-compat` prose), and the call/spawn surfaces that judge and fleet
consume by name.

> You probably want the config instead: a `providers` entry in
> `bro.config.json`. Install this only when building a new provider kind.

## Install

```bash
npm i @broject/providers
```

Requires Node ≥ 22. ESM only.

## Surface

- Provider kind adapters — `api` (one host, per-model wires), `acp` (typed on `jev`-family, prose otherwise), `cli` (stdout-parsed template)
- `apiKeyEnv` / `apiKeyCommand` resolution — secret-store lookup, never a literal key in config
- The `ProviderEntry` union consumed by `judge.provider` and `agents.<backend>.provider`

## Links

- Docs: https://broject.dev/docs/commands/providers
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/providers
- CLI: https://www.npmjs.com/package/@broject/bro
