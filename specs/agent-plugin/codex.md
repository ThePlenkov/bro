---
parent: agent-plugin
---

# agent-plugin/codex — the Codex adapter

## Problem

Codex discovers plugins through configured marketplaces
(`codex plugin marketplace add`) and injects agent instructions
separately from hooks. Without a normative surface, Codex-only session
instructions and hook coverage drift from the shared core — instructions
duplicating skills text, or hook events silently missing.

## Design

- **Install**: `codex plugin marketplace add ThePlenkov/bro` →
  `codex plugin add bro@bro`. Cache root:
  `~/.local/share/agent-config/codex/plugins/cache/bro/bro/<version>`.
- **Surface**: `integrations/codex/hooks/hooks.json` +
  `hooks/run.sh` (the shared chain) + `INSTRUCTIONS.md` — Codex-only
  session instructions injected from the plugin (the
  feature/codex-instructions lineage). `INSTRUCTIONS.md` carries only
  host vocabulary: how Codex should reach bro, never shared policy that
  duplicates skills text.
- **Event map**: `SessionStart`, `PreCompact`, `PostCompact`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`,
  `Stop`. `PermissionRequest`'s stdout is the answer — a denied tool call
  must never be a silent fail-open there (master spec, lifecycle table).

## Verify

- `codex plugin list` shows `bro@bro` installed and enabled at the
  expected cache root.
- All eight events dispatch through `run.sh` with the shared contract;
  the permission path answers through stdout even when bro is degraded.
- `INSTRUCTIONS.md` contains no skills-derived policy text — a review
  check, not a lint.
