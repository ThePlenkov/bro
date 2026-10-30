---

name: otel
description: "Use when enabling, inspecting, or debugging bro's hook-first telemetry — 'which hooks fire in this repo', 'send hook events to an OTLP collector', per-hook payload allowlists, sampling, or reading the file sink. Thin wrapper over the bro CLI: `bro otel status|test|on|off` — mechanics live in @broject/otel emitHook on the `bro hooks` dispatch path (spec specs/bro-xgejl.md). Requires `bro` (npx -y @broject/bro@0)."
---

# /otel (bro)

**All mechanics live in the `bro` CLI and `@broject/otel`.** This skill
is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

Every `bro hooks <event>` dispatch runs through the `emitHook` facade:
resolve the `otel` config section → apply the per-hook policy (on/off,
`sample`, `collect` allowlist) → build one record → write the
configured sink. Telemetry answers two operator questions at once:
**which hooks are ACTIVE** (counts + latency per event) and **WHAT gets
collected** (the allowlist is the whole contract — no payload field
leaves the machine unless named).

**Off by default and free when off.** `enabled=false` short-circuits
before any payload work: one memoized config read and a boolean per
hook. `BRO_TELEMETRY=0` kills emission outright, same switch as the
command journal.

| Command                        | What it does                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bro otel status [--json]`     | enabled? resolved exporter (file path / otlp endpoint), `*` + per-hook policies, event counts from the file sink                         |
| `bro otel test <hook>`         | fire a synthetic payload through the facade — prints the exact exported record, the policy, and the payload fields the allowlist dropped |
| `bro otel on` / `bro otel off` | flip `otel.enabled` in `bro.config.local.json` — the local layer, never the committed config                                             |

## Enable

```bash
bro otel on          # writes {"otel":{"enabled":true}} → bro.config.local.json
bro otel status      # verify: exporter=file → <git-common>/bro/otel/hooks.jsonl
```

`otel.enabled` alone lights every hook at the **meta-only** level —
event name, session, client, duration, ok/error. Payload fields are
always explicit opt-in via `collect`.

## Config reference

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
    "*":         true,                   // default policy: false | true | {sample, collect}
    "post-tool": { "sample": 0.1, "collect": ["tool_name", "tool_response.success"] }
  }
}
```

- `'*'` is the default policy; a named hook entry overrides it;
  `false` drops the hook. Absent `'*'` reads as `true` — `enabled`
  alone lights all hooks. `'*': false` is the "enabled but silent"
  spelling.
- `collect` lists dotted payload paths (`tool_input.command`); scalar
  leaves land as `payload.<path>` — objects, arrays, and missing paths
  drop silently. `true` (no object) means meta-only.
- `sample` is the per-event keep probability `0..1` — `0.1` keeps ~10%
  of that hook's events.
- Merge: local > project > global (standard layers). `otel` is an
  **operator** section — `bro doctor` warns if a repo commits it; use
  `bro.config.local.*` or `~/.config/bro/config.json`.

**Trust model (why a repo cannot aim your telemetry).** Arming
(`enabled`), the exporter (type/path/endpoint/headers), and every
`collect` allowlist are read from operator-owned layers only: the
global config plus any project/local config file `git ls-files` reports
**untracked** — the file `bro otel on` writes in a real checkout. A
_committed_ `otel` block is repo-controlled, so the facade ignores it
for everything except narrowing: it can turn telemetry off, drop a
hook, or lower a sample, but never arm, redirect, or collect. A
committed `bro.config.local.json` is still committed — the git index,
not the filename, is the verdict. In a directory git doesn't know,
every file is unattributable and only the global layer can arm. `bro
otel status` prints a note when a committed `enabled=true` is ignored —
that is the opt-in step, not a bug.

## Hook catalog

| bro event                                                   | host events                     | payload fields worth collecting                                          |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `session-start`                                             | SessionStart                    | `session_id`, `hook_event_name`                                          |
| `post-compaction`                                           | PostCompaction                  | `session_id`                                                             |
| `pre-compact`                                               | PreCompact                      | `session_id`                                                             |
| `prompt-submit`                                             | UserPromptSubmit                | `session_id`, `prompt` ⚠ content                                         |
| `pre-tool`                                                  | PreToolUse                      | `tool_name`, `tool_use_id`, `tool_input.command`, `tool_input.file_path` |
| `post-tool`                                                 | PostToolUse, PostToolUseFailure | `tool_name`, `tool_input.command`, `tool_response.success`               |
| `stop`                                                      | Stop                            | `session_id`, `stop_hook_active`                                         |
| `permission`                                                | PermissionRequest               | `tool_name`, `tool_input.command`                                        |
| `prepare-commit-msg`, `reference-transaction`, `post-merge` | git hooks                       | — (meta rows only)                                                       |

Meta fields (`session`, `client`, `ms`, `ok`, `error`) ride every row
for free — the allowlist only governs `payload.*`.

## Reading the sink

The default file sink is one JSONL row per event at
`<git-common>/bro/otel/hooks.jsonl` (locked append, 512KB tail cap):

```bash
bro otel status                                  # counts per event
jq -r .event .git/bro/otel/hooks.jsonl | sort | uniq -c
jq 'select(.event=="hook.post-tool") | .ms' .git/bro/otel/hooks.jsonl
```

For a collector: `exporter.type=otlp` posts OTLP/HTTP-JSON log records
(`bro.hook.<event>` bodies, attributes flattened) via a **detached**
poster — a dead collector loses the row, never stalls the hook. Point
`exporter.endpoint` or rely on `OTEL_EXPORTER_OTLP_ENDPOINT`; Grafana
dashboards under `observability/grafana/` read the same `bro.*` event
shape the `lane.<provider>.*` events already use.

`exporter.type=stdout` writes rows to **stderr** — hook stdout is the
host's control channel; live debugging only.

`bro otel test session-start` previews without writing: it prints the
record a real event would produce plus the `payload fields not
collected` list — check allowlists before enabling.

## Migration note

`bro fleet telemetry` (the perf journals) and `lane.<provider>.*` otel
events keep working — they are session evidence and lane telemetry,
not hook telemetry. The facade is the aggregation layer for hook
events: use `bro otel` to answer "which hooks fire, how fast, with
what"; `fleet telemetry` for probe-level latency inside a hook.
