# bro-5lfp1 — acp cold-start noise: trim spawn warmup in loop worktrees

## Problem

Every `bro loop`/`bro agents` worker cold-start pays a full agent-CLI
warmup inside the spawned worktree, and pays it again on restart
(bro-rbqgf: each killed/parked worker cold-restarts — ACP session +
skills discovery + worktree npm ci). Measured on a real worker log
(`devin acp` under `devin -p`, the `agents.native` backend), the
session/new warmup reports:

- `skills discovery … providers=[devin,agents_standard,cursor,
  windsurf,claude,opencode,zed,copilot] loaded=95
  by_provider=[builtin=3,claude=7,copilot=1,devin=84] errors=86` —
  86 scan errors, re-emitted on every session/prompt, and ~95 skill
  entries bloating the worker's system prompt.
- `plugin::activate: skipping plugin 'bro': blocked by
  'repo:<worktree>'` plus `io error` WARNs off a stale installed
  plugin pointing at a dead worktree cache.

The 86 errors are entirely the **foreign-tool import scan** — devin's
`read_config_from` importers probing claude/cursor/windsurf/opencode/
zed/copilot candidate paths. In this repo every one of those imports
is dead weight or worse:

- `claude` loads `~/.claude/skills` — 7 skills that are all duplicates
  of `~/.agents/skills` (already loaded under the devin scope), plus a
  committed-but-dangling `.claude/skills/typesafe-ai` symlink
  (`.agents/skills/` is gitignored, so the target never materializes
  in a fresh worktree).
- `cursor`, `windsurf`, `opencode`, `zed` have no config in this repo
  at all — the probes are pure error candidates.
- `copilot` is the only clean importer (1 unique skill,
  `hindsight-coding-agent`) and stays enabled.
- `agents_standard` must stay enabled — it is what loads `AGENTS.md`,
  the contract every worker runs under.

Verified by probe (`devin acp` + ndjson handshake against a loop
worktree): disabling the five dead importers takes
`errors=86 → 0`, `loaded=95 → 88`.

The `plugin 'bro': blocked` WARN is **policy working**, not a bug:
`.devin/config.json` deliberately forbids the installed `ThePlenkov/bro`
plugin so a released plugin can never shadow the checkout's own
manifest/hooks (`.devin/hooks.v1.json` wires them directly). The WARN
stays; what produced the extra `io error` WARNs was a stale
`bro (bro--bro-gkbe)` install on the operator's machine — removed
locally with `devin plugins remove`, not a repo change.

## Design

`read_config_from` lands in the committed **project** config
`.devin/config.json` — documented as the committed layer, so every
linked worktree inherits it without a generated file (a
`.devin/config.local.json` written per worktree would dirty the tree:
nothing ignores it, and a worker that commits it leaks machine policy
into the PR).

```json
"read_config_from": {
  "agents_standard": true,
  "cursor": false,
  "windsurf": false,
  "claude": false,
  "copilot": true,
  "opencode": false,
  "zed": false
}
```

Explicit `true`s, not omissions — the block reads as policy ("these
imports are on") rather than config drift.

## Non-goals

- **MCP warmup stays.** `chrome-devtools` (`npx -y` cold spawn, ~5s)
  and `deepwiki` (~1s) live in user-scope `mcp_config.json`. A committed
  `.devin/mcp_config.json` disable would strip them from interactive
  sessions too — a product-level per-worker MCP policy needs a devin
  lever that doesn't exist yet (verified `DEVIN_PLUGIN_DISCOVERY` does
  not gate plugin discovery either).
- **The `blocked by repo` WARN stays** — it is the honest signal of the
  forbid doing its job.
- **Dangling `*/skills/typesafe-ai` symlinks** (`.claude/`, `.devin/` →
  gitignored `.agents/skills/`) — a skills-sync convention issue worth
  its own bead, not this diff.
- **Vendor-blindness holds** — no devin knowledge enters
  `packages/core`; this diff is repo policy, not provider code.
