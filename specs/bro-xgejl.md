---

scope:
- packages/otel/**
- packages/providers/src/otel.ts
- packages/providers/src/index.ts
- packages/cli/src/commands/otel.ts
- packages/cli/src/commands/hooks.ts
- packages/cli/src/plugins.ts
- packages/cli/package.json
- skills/otel/SKILL.md
- contract/cli.json
- site/content/docs/reference/otel.md

---

# bro-xgejl — otel: hook-first telemetry — one config-enabled facade exporting every hook event

## Problem

bro's telemetry today is ad-hoc: `lane.devin.*` events from
@broject/devin, per-probe `hook.probe.*` / `hook.event` spans, and the
`bro fleet telemetry` perf journals. Each surface answers its own narrow
question and none answers the operator's two plain ones:

1. **Which hooks are ACTIVE** — did session-start / prompt-submit /
   post-tool actually fire for this repo, how often, how fast?
2. **WHAT gets collected** — which payload fields leave the machine?

The hook dispatch path already sees every event — one entry, one place
— but exports nothing about it. A new package puts the telemetry where
the events are: `bro hooks <event>` dispatch → facade → sink.

## Design

### Facade — `packages/otel` (@broject/otel)

One sync entry: `emitHook(name, payload, meta)`. Sync because hooks are
short-lived processes — an async facade floats promises that die with
the parent.

- `name` — the bro event name (`session-start`, `prompt-submit`,
  `pre-tool`, `post-tool`, `stop`, `permission`, `pre-compact`,
  `post-compaction`, plus the payload-less git-hook events
  `prepare-commit-msg`, `reference-transaction`, `post-merge`).
- `payload` — the normalized hook input (`HookInput`: `session_id`,
  `tool_name`, `tool_input.*`, `tool_response.success`, `prompt`, …).
- `meta` — `{ sessionId?, client?, durationMs?, ok?, error?, dir? }`.
  `client` is the detected host dialect (`cursor` / `codex` /
  `default`); `dir` anchors config + git resolution (default `cwd`).

Pipeline per call: resolve config → policy for `name` → sampling →
build record → write sink. Everything wrapped fail-open: a telemetry
bug must never stall or fail a hook (same rule as the perf journal).

**Config read** — `loadConfig(dir, { otel: otelSection })`, memoized
per dir for the process's life. Hook processes are one-shot, so the
memo is really for long-lived hosts (serve). `BRO_TELEMETRY=0`
short-circuits before the config read — the repo-wide kill switch
stays absolute.

**Zero overhead when off** — `enabled=false` (the default) returns
before any payload work: the cost of a disabled event is one config
resolve (memoized) and a boolean check.

**Sampling** — `sample` is the per-hook keep probability (`1` default,
clamped `[0,1]`), rolled per event. `bro otel test` bypasses sampling —
it exists to show what a fired event exports, not to roll dice.

**Field allowlist** — `collect` is a list of dotted paths into the
payload (`tool_name`, `tool_input.command`, `tool_response.success`,
`session_id`, `prompt`, …). Scalar values become `hook.payload.<path>`
attributes; missing/non-scalar paths drop silently. Nothing is
collected unless listed — `true` means the event counts with meta only
(session, client, duration, ok), never the payload. PII is opt-in by
construction.

**Record** — one row per emitted event:

```json
{
  "ts": "…",
  "event": "hook.post-tool",
  "session": "…",
  "client": "default",
  "ms": 12,
  "ok": true,
  "payload": { "tool_name": "exec" }
}
```

### Config — `otel` section

```jsonc
"otel": {
  "enabled": false,                      // master switch
  "exporter": {
    "type": "file",                      // file | otlp | stdout
    "path": "",                          // file sink; '' → <git-common>/bro/otel/hooks.jsonl
    "endpoint": "",                      // otlp sink; '' → OTEL_EXPORTER_OTLP_* env / provider.env
    "headers": {}                        // otlp only
  },
  "hooks": {
    "*":        true,                    // default policy: false | true | {sample, collect}
    "post-tool": { "sample": 0.1, "collect": ["tool_name", "tool_response.success"] }
  }
}
```

- `'*'` is the default policy, absent `'*'` = enabled-with-no-collect
  (count-only) — `otel.enabled` alone turns every hook on at the
  meta-only level; `hooks."*": false` is how a repo says "enabled but
  silent by default". A named hook entry overrides `*`; `false`
  disables that hook.
- Merges through the standard layers — local > project > global —
  because the section rides the existing `loadConfig` schema registry
  (`configKey: 'otel'`).
- `CONFIG_SECTION_LAYERS.otel = 'operator'` — telemetry is a machine
  subscription, same class as `providers`/`notify`; `bro doctor` warns
  if a repo commits it.

#### Trust — which layer may say what

A committed `bro.config.*` is repo-controlled content — it arrives via
`git clone`/`pull` without operator review, so it must never be able to
aim telemetry at an attacker-chosen collector or widen what gets
shipped (prompt text, command lines). The facade therefore resolves
config as TWO merges over `loadConfigLayers`:

- **Operator-owned** — the global layer plus any project/local config
  file git reports **untracked** (`git ls-files --error-unmatch` →
  exit 1 + empty stdout; every other answer — tracked, non-repo dir,
  stalled git — fails closed to untrusted). These layers alone decide:
  arming (`enabled`), `exporter` (type/path/endpoint/headers), and
  every `collect` allowlist. `.gitignore` is advisory — a committed
  `bro.config.local.json` is just another tracked file, so the index,
  not the filename, is the verdict.
- **Every layer (committed included)** — may only _narrow_: AND on
  `enabled`/`hooks.<name>.enabled`, MIN on `sample`. A repo can
  silence telemetry or sample harder; it cannot arm it, redirect it,
  or add a payload field. `hooks` policies combine per hook name as
  `{enabled: mine && theirs, sample: min, collect: mine}`.

`bro otel status` surfaces `armedByCommitted` — a committed
`enabled=true` the operator layers never confirmed prints a hint naming
the opt-in step rather than reading as broken.

### Sinks

- **file** (default) — one JSONL row per event to `exporter.path`, or
  `<git-common>/bro/otel/hooks.jsonl` (sibling of `hooks/perf`,
  `hooks/trace`). Same journal discipline as the perf file: locked
  append, size cap with tail-keep, fail-open. This is the sink `bro
  otel status` reads for event counts.
- **otlp** — OTLP/HTTP-JSON log record via @broject/providers
  `otelEvent('hook.<name>', attrs)`. `exporter.endpoint` wins when set;
  else the standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `provider.env`
  resolution. Delivery is `postDetached` — a detached poster carries
  the record out so a dead collector can never stall the hook's exit.
  providers' `otelEvent` gains `{endpoint?, detached?}` opts
  (backwards-compatible) and exports `otelEndpoint()` so `bro otel
  status` can report the resolved endpoint.
- **stdout** — one JSON row per event on **stderr** (stdout is the
  hook-protocol channel — a telemetry row there would corrupt the
  control answer). For live debugging only.

### Command — `bro otel`

- `bro otel status [--json]` — enabled flag, resolved exporter
  (type + endpoint/path), the effective `*` policy, every named-hook
  override, and per-event counts read back from the file sink.
- `bro otel test <hook> [--json]` — resolves the policy, fires a
  synthetic payload through the record builder, and prints the exact
  row the sink would receive plus the fields the allowlist dropped.
  Accepts bro names (`post-tool`) and host names (`PostToolUse`,
  `sessionStart`). A disabled hook says so and shows the would-be
  record anyway — the point is previewing the export, not enforcing
  the gate.
- `bro otel on | off` — flips `otel.enabled` in
  `bro.config.local.json` (created if absent; refuses to shadow a
  `bro.config.local.ts` — same rule as `bro setup`). Telemetry is
  operator config: the toggle lands in the local layer, never the
  committed file.
- Registered as group `fleet` (with `trace`/`telemetry`) —
  `bro fleet otel status` and `bro otel status` both resolve.

### Skill — `skills/otel/SKILL.md`

Enable flow, the config reference, the hook catalog with each event's
payload fields, reading the file sink (`jq` lines), pointing
`observability/grafana/` dashboards at the OTLP backend, sampling
semantics, and the migration note: `bro fleet telemetry` perf journals
and `lane.devin.*` events keep working — the facade is the aggregation
layer, not a replacement.

### Wiring — `bro hooks` dispatch

`runHooksCommand` wraps `dispatchHook` in a try/finally that already
computes duration (perf journal, `hook.event` span). `emitHook` rides
the same finally — meta `{sessionId, client, durationMs, ok, error}` —
so every dispatched event emits exactly one row with its real latency
and outcome. The git-hook entry points (`prepare-commit-msg`,
`reference-transaction`, `post-merge`) emit too — same facade, empty
payload.

## Non-goals

- No metrics SDK — counts come from aggregating sink rows
  (`bro otel status`), dashboards do the rate math.
- No polling loop, no collector sidecar — telemetry is strictly
  hook-driven.
- The perf/trace journals stay — they're session evidence, not
  operator telemetry; the facade does not subsume them.

## Acceptance

- `otel.enabled=true` + `hooks."*"=true`: a session firing
  session-start / prompt-submit / post-tool appends one file-sink row
  each; `enabled=false` writes nothing.
- `bro otel test sessionStart` prints the exact exported record.
- Hooks never stall: every facade path is sync + fail-open; otlp
  delivery is detached.
