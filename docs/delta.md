# Delta support

Delta supports **Skills** (`SKILL.md`) and **MCP servers**, but not the
Agent Plugin hook layer (session-start/stop etc.) that bro ships for other
clients. So bro works in Delta as:

1. A **global skill** (`~/.agents/skills/bro/SKILL.md`) for command routing
   and policy. Create it from the routing/policy guidance in this repository
   (`AGENTS.md` + skill routing) or copy the installed skill; keep per-project
   skills under `.agents/skills`.
2. The **bro CLI** on `PATH` (`bro doctor` first).
3. Optional **MCP**: `bro mcp` over stdio when Delta supports custom
   stdio servers for your account. Delta's public MCP page is OAuth-oriented.
4. **Personal `AGENTS.md`** (`~/.config/delta/AGENTS.md`): Delta re-reads
   it each turn. Put critical gates there because hooks do not run.

## Limitations

- No automatic hook rehydrate / stop gate. Run `bro review act status`
  explicitly before declaring done.
- Agent spawn still requires `bro` on the execution environment's PATH.
- Each spawn may need `bd`/`dolt` installed for beads storage.