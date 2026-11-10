# Delta support

Delta supports **Skills** (`SKILL.md`) and **MCP servers**, but not the
Agent Plugin hook layer (session-start/stop etc.) that bro ships for other
clients. So bro works in Delta as:

1. A **global skill** (`~/.agents/skills/bro/SKILL.md`) for command routing
   and policy. The repo ships it — copy `skills/bro/` into the global skill
   dir, or keep per-project skills under `.agents/skills`.
2. The **bro CLI** — `bro` on `PATH`, or `npx -y @broject/bro@0` for the
   zero-install form the agents/delegate skills also accept (`bro doctor`
   first either way).
3. Optional **MCP**: `bro mcp` over stdio when Delta supports custom
   stdio servers for your account. Delta's public MCP page is OAuth-oriented.
4. **Personal `AGENTS.md`** in Delta's configured rules dir —
   `~/.config/delta/AGENTS.md` by default, `$XDG_CONFIG_HOME/delta/` when
   `XDG_CONFIG_HOME` is set (Delta does not fall back to `~/.config` in
   that case), `%APPDATA%\delta\` on Windows. Delta also honors `AGENT.md`
   before `AGENTS.md`. It re-reads the file each turn, so put critical
   gates there because hooks do not run.

## Limitations

- No automatic hook rehydrate / stop gate. Run `bro review act status`
  explicitly before declaring done — it gates the current branch's open
  PR, and exits with an error when there is none.
- Agent spawn still requires `bro` on the execution environment's PATH
  (the `npx` form works for CLI calls, not the spawned worker argv).
- Each spawn may need `bd`/`dolt` installed for the beads task store.
