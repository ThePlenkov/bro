---
parent: bro-1qpk.4
---

# bro-1qpk.4.3 — transforms: bro read tools, commands, MCP mount

## Problem

The agent inside opencode reads bro only by shelling `bro …` in bash —
no typed tools, no slash commands, no MCP mount of the facade.

## Design

### `ctx.tool.transform` — bro read verbs as model tools

One `editor.namespace({name:'bro'})` + `editor.add` per read verb,
JSON-Schema inputs (`{type:'object'}` — no zod in the standalone
module), `execute` spawns the resolved bro command and returns
`{content}`:

| tool id | spawn | Purpose |
| ------- | ----- | ------- |
| `bro_status` | `bro status --json` | live board |
| `bro_convoy_status` | `bro convoy status` | mol DAG |
| `bro_act_status` | `bro act status --json` | PR exit gate |
| `bro_fleet` | `bro fleet` | mols × agents × worktrees × PRs |

Every tool spawns through the ONE resolved bro command — no `bd` spawn
(the module resolves exactly one CLI; `bd ready` would need a second
ladder for a read `bro status` already covers).

`--json` everywhere the verb supports it; `execute` answers a string —
never throws into the tool runner (stderr tail becomes the content on
nonzero exit).

### `ctx.command.transform` — `/bro` commands

`editor.add({name:'bro', …})`: executor prompts the session with the
fresh `bro status` board plus the invoked subcommand's output. Keep one
command (`bro`) taking arguments — a command per verb duplicates the
CLI's own help.

### `ctx.mcp.transform` — `bro serve` mount

`editor.set('bro', {type:'remote', url:'http://127.0.0.1:<port>'})` —
only when the plugin option `mcp.port` (or `options.mcpPort`) is set;
`bro serve` is opt-in infra, the transform must not conjure a dead
server into every config.

### Acceptance

- transform registers the 4 tools above, each spawn fail-open
- `/bro` command prompts with board + verb output
- MCP mount registered only when configured
- tests drive `execute` against the stub CLI seam
