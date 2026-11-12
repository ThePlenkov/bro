---

title: bro fleet trace
description: OTLP export of session trace journals to an observability backend.
---

`bro fleet trace` (alias `bro trace`) exports unexported session trace
journals as OTLP/HTTP spans for cost attribution and debugging.

| Command                                                        | What it does               |
| -------------------------------------------------------------- | -------------------------- |
| `bro fleet trace export [--session <id>] [--dry-run] [--json]` | Export pending trace spans |

Configure endpoints and credentials in `~/.config/bro/config.json` or
the gitignored `bro.config.local.json` under `telemetry` (see
[configuration](/docs/configuration)). Put operator telemetry settings and credentials
in `~/.config/bro/config.json` or the gitignored `bro.config.local.json`,
not the committed project `bro.config.json`. For hook-first telemetry see
[otel](/docs/commands/utility) / `bro otel`.
