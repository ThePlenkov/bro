---
parent: agent-plugin
---

# agent-plugin/opencode — the opencode adapter

## Problem

opencode loads plugins as directories over its native V2 plugin bus and
raises a TUI half only for a package that also has a server. The bro
adapter is therefore not a `hooks.json` — it is a three-module
extension — but it must still deliver the same lifecycle contract as the
hook-shaped clients, plus the push channel that turns bro from something
an agent polls into something that arrives.

## Design

- **Install**: `"plugin": ["@broject/bro"]` in `opencode.json`, or
  `bro clients install opencode` → `~/.config/opencode/plugins/bro`
  (global) / `.opencode/plugins/bro` (local). This directory is a
  **catalog plugin** — the three modules belong together.
- **`index.ts`** — the server half, a verbatim copy of
  `packages/agent-plugins/opencode/src/opencode.ts`: the
  context/compaction/prompt session hooks, the tool guard + result
  enrichment, the permission evaluate hook, the shell env, the bro tool
  namespace (`bro_status`, `bro_convoy_status`, `bro_act_status`,
  `bro_fleet`, `bro_next`, `bro_drill_status`, `bro_review_threads`),
  the `/bro` and `/act` commands, bro's skills registered into opencode's
  skill registry, and the RPC registration — the `bro` contract: the
  `board`, `notify` and `prompt` methods plus the `changed` and
  `attention` events, the channel bro pushes state INTO opencode through.
- **`rpc.ts` / `tui.tsx`** — the RPC client and the terminal half (the
  TUI raises only because the server half exists).
- **Skills**: installed as a directory, bro's skills reach opencode
  through opencode's own plane — `~/.agents/skills/`, where
  `bro skills sync` puts them — so the plugin-side registration and the
  agents-skills plane never double-register.
- Generated-adapter direction: the verbatim-copy modules fold into the
  shared core (`packages/agent-plugins/adapter-core/`) the way pi and omp did;
  a divergence between the copy and the core is drift to repair, not a
  fork to maintain.

## Verify

- `bro clients list` shows the opencode global and local rows installed.
- RPC board state pushes (`changed` / `attention`) reach an open TUI
  without the agent polling.
- Skills register exactly once across both paths (plugin-adjacent and
  `~/.agents/skills/`).
