# @broject/otel

[![npm](https://img.shields.io/npm/v/@broject/otel)](https://www.npmjs.com/package/@broject/otel)

Hook-first telemetry for `bro` — the `emitHook` facade the `bro hooks`
dispatch calls once per event: `otel` config section → per-hook policy
(enable / `sample` / `collect` payload allowlist) → file, OTLP, or
stdout sink. Sync and fail-open — telemetry never stalls a hook, and
`enabled=false` (the default) costs one memoized config read.

> You probably want the CLI instead — `bro otel status` shows what's
> armed and what fired. Install this only when building a hook or
> connector that emits through the same facade.

## Install

```bash
npm i @broject/otel
```

Requires Node ≥ 22.18. ESM only.

## Surface

- `emitHook(name, payload, meta)` — the single entry; resolves policy, samples, builds the record, writes the sink
- `otelSection` — the `otel` config schema (`enabled`, `exporter`, `hooks."*"` default + per-hook overrides)
- `hookRecord` / `collectFields` — the pure record builder behind `bro otel test`
- `readSinkRows` / `otelSinkPath` — the file sink read-back `bro otel status` uses
- `hookEventName` / `OTEL_HOOK_EVENTS` — host spelling → bro event name + the emitted catalog

## Links

- Spec: <https://github.com/ThePlenkov/bro/tree/main/specs/bro-xgejl.md>
- Source: <https://github.com/ThePlenkov/bro/tree/main/packages/otel>
- CLI: <https://www.npmjs.com/package/@broject/bro>
