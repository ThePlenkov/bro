---

title: bro work goal
description: Session-scoped completion goal with hook reminders and judge verdicts.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro work goal` (alias `bro goal`) sets a session-scoped completion goal.
Hooks remind on stop and can ask the judge to verdict whether the goal
was met. Pass the condition directly (no `set` verb) — unknown positional
words become part of the condition.

| Command                         | What it does                                 |
| ------------------------------- | -------------------------------------------- |
| `bro work goal <condition>`     | Set/replace the goal for the current session |
| `bro work goal status [--json]` | Show current goal state                      |
| `bro work goal pause`           | Pause goal reminders                         |
| `bro work goal resume`          | Resume goal reminders                        |
| `bro work goal clear`           | Clear the goal                               |

Goal state lives under the git common dir and is consumed by hook
connectors (see [hooks](/docs/commands/utility)).
