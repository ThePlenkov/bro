---
parent: agent-plugin
---

# agent-plugin/claude — the Claude Code adapter

## Problem

Claude Code loads plugins from marketplaces; a marketplace may be
registered as a GitHub source or as a directory source pointing at a
local checkout — the plugin's skills and hooks then track whatever that
directory contains at any moment. Cached plugin versions also drift from
the installed CLI (a 0.2.5 plugin cache beside a 0.3.0 CLI was a live
instance on a real machine). The adapter must be correct in both worlds
and the drift must be visible, not silent.

## Design

- **Install**: `/plugin marketplace add ThePlenkov/bro` →
  `/plugin install bro@bro`.
- **Surface**: `plugins/claude/bro/hooks/hooks.json` only. Claude sets
  `CLAUDE_PLUGIN_ROOT`; the shared `hooks/run.sh` resolves the bro binary
  and carries the fail-open contract. No INSTRUCTIONS.md, no extension
  code, no per-client skill copies.
- **Event map**: `SessionStart`, `PreCompact`, `UserPromptSubmit`,
  `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreToolUse` — each
  dispatched as `"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" <event> || true`
  with timeout 20. **Gap (documented, per the master table's paired
  pre/post-compact requirement):** Claude Code exposes no `PostCompact`
  event — the manifest carries `PreCompact` only; the post-compact
  rehydrate rides the post-compaction `SessionStart` instead.
- **Marketplace sources**: a directory source (pointing at a dev
  checkout) is a supported, documented split — the plugin is
  dev-reactive while hooks still resolve the stable PATH binary in
  foreign repos (master spec, "Install surface"). A GitHub source pins
  plugin and hooks to published releases.
- **Cloud agents** do not run `SessionStart`; the first prompt
  rehydrates once.
- Skills arrive through the plugin's own `skills/` tree — no separate
  skills-sync plane for Claude.

## Verify

- Fresh install: `/plugin install bro@bro` yields skills + hooks;
  `bro clients list` shows the claude row installed.
- Hook chain: with bro absent or broken, every mapped event exits 0 and
  the session proceeds.
- Version drift between the plugin cache and `bro --version` is
  advisory: reportable, never a gate — hooks fail open either way.
