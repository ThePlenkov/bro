---

title: bro fleet mcp
description: Stdio MCP server over the read planes for MCP-capable clients.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro fleet mcp` (alias `bro mcp`) runs a stdio MCP server exposing bro
read planes as tools (e.g. `bro_fleet_status`, `bro_agents_status`) for
clients like Windsurf, Zed, Goose, Gemini CLI, and Claude Desktop.

| Command         | What it does               |
| --------------- | -------------------------- |
| `bro fleet mcp` | Start the stdio MCP server |

Configure the client to launch `bro fleet mcp` (or `npx -y @broject/bro fleet mcp`)
in the repo/root context. The server reads from the same bro state planes
as the CLI.
