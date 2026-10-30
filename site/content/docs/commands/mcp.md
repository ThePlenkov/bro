---

title: bro fleet mcp
description: Stdio MCP server over the read planes for MCP-capable clients.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro fleet mcp` (alias `bro mcp`) runs a stdio MCP server exposing bro
read planes as tools (e.g. `bro_work_status`, `bro_agents_fleet`) for
clients like Windsurf, Zed, Goose, Gemini CLI, and Claude Desktop.
Tool names are generated from registered planes and reads — run
`bro fleet mcp --tools` to see what's advertised for your repo.

| Command         | What it does               |
| --------------- | -------------------------- |
| `bro fleet mcp` | Start the stdio MCP server |

Configure the client to launch `bro fleet mcp` from the repo or root context. Use `npx -y @broject/bro fleet mcp` only after 0.3.0 is published to npm. The server reads from the same bro state planes as the CLI.
