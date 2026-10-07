# @broject/guard

[![npm](https://img.shields.io/npm/v/@broject/guard)](https://www.npmjs.com/package/@broject/guard)

The declarative guard engine behind `bro guard` and the hook's prompt
contributions — `when` clause evaluation (events, match keys, state
probes, judge veto), the fired-set budget, and the verdict journal.

> You probably want the CLI instead: `bro guard list` shows what's
> armed. Install this only when building a hook or connector that
> evaluates guards.

## Install

```bash
npm i @broject/guard
```

Requires Node ≥ 22. ESM only.

## Surface

- `runGuards` — evaluate collected guards against an event and session state
- `guardConnector` / `BUILTIN_GUARDS` — the connector contributions every repo gets
- `GuardConfig` — the `guard` config section shape (`defs`, `enabled`, `maxPerEvent`)

## Links

- Docs: https://broject.dev/docs/commands/guard
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/guard
- CLI: https://www.npmjs.com/package/@broject/bro
