---

title: bro fleet provider
description: Claude-facing Messages-API host — run bro as a provider for Claude Code.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro fleet provider` (alias `bro provider`) hosts a Messages-API listener
so Claude Code can run on bro. Use `provider serve` to start the host,
and the wiring helpers to point clients at it.

| Command                                          | What it does                                     |
| ------------------------------------------------ | ------------------------------------------------ |
| `bro fleet provider serve [--port N] [--host H]` | Start the Messages-API host listener             |
| `bro fleet provider url`                         | Print the base URL to configure clients          |
| `bro fleet provider token`                       | Print/configure the auth token                   |
| `bro fleet provider env`                         | Emit shell env to wire `ANTHROPIC_BASE_URL`/auth |
| `bro fleet provider ensure`                      | Ensure the host is running                       |

Wire Claude Code by setting `ANTHROPIC_BASE_URL` to the host URL and the
appropriate auth env. The conductor mounts an `acp` provider entry behind
`/v1/messages` for session-grade hosting; see [serve/status](/docs/commands/status).
