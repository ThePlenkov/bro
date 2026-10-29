---

title: bro fleet trace
description: OTLP export of session trace journals to an observability backend.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro fleet trace` (alias `bro trace`) exports unexported session trace
journals as OTLP/HTTP spans for cost attribution and debugging.

| Command                                                        | What it does               |
| -------------------------------------------------------------- | -------------------------- |
| `bro fleet trace export [--session <id>] [--dry-run] [--json]` | Export pending trace spans |

Configure endpoints and credentials in `~/.config/bro/config.json` or
the gitignored `bro.config.local.json` under `telemetry` (see
[configuration](/docs/configuration)). Do **not** put operator secrets in
the committed project `bro.config.json`. For hook-first telemetry see
[otel](/docs/commands/utility) / `bro otel`.
