---

title: bro fleet mcp
description: Stdio MCP server over the read planes for MCP-capable clients.
---

`bro fleet mcp` (alias `bro mcp`) runs a stdio MCP server exposing bro
read planes as tools (e.g. `bro_work_status` and named reads
like `bro_agents_fleet`) for
clients like Windsurf, Zed, Goose, Gemini CLI, and Claude Desktop.
Tool names are generated from registered planes and reads — run
`bro fleet mcp --tools` to see what's advertised for your repo.

| Command         | What it does               |
| --------------- | -------------------------- |
| `bro fleet mcp` | Start the stdio MCP server |

Configure the client to launch `bro fleet mcp` from the repo or root context — `npx -y @broject/bro fleet mcp` works on npm `latest` (0.3.0). The server reads from the same bro state planes as the CLI.
