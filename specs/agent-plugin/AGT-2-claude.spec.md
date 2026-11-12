---
template: brotocol/spec@2
id: AGT-2
title: Claude Code — manifest surface, split post-tool, real stop block
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/claude/
aliases:
  - claude
---

# AGT-2 — Claude Code: manifest surface, split post-tool, real stop block

## Problem

Claude Code is bro's oldest host and its richest manifest surface:
the repo root itself is the plugin (`.claude-plugin/plugin.json` +
`skills/`), and `plugins/claude/bro/hooks/hooks.json` wires eight
native hook events to `hooks/run.sh`. The host gives bro something
no other manifest host gives: a **real `Stop` → `decision:block`**
slot and a **split post-tool outcome** (`PostToolUse` /
`PostToolUseFailure`). The spec must pin what is leveraged natively
vs what stays adapted, and name the declared gaps honestly.

## Design

### Surface: `manifest`, sync, repo-root plugin

`plugins/claude/bro/hooks/hooks.json` pipes each event's stdin to
`${CLAUDE_PLUGIN_ROOT}/hooks/run.sh <event>`; run.sh resolves the
CLI (checkout dist → `bro` on PATH), bounds every call, and exits 0
on any failure — the fail-open contract is the adapter's whole job
on this surface.

### Event mapping (HOOK_MATRIX `claude` row)

| bro event | Claude native | effects |
| --------- | ------------- | ------- |
| session-start | `SessionStart` | context |
| pre-compact | `PreCompact` | context |
| prompt-submit | `UserPromptSubmit` | context |
| pre-tool | `PreToolUse` (`Bash`) | block, rewrite |
| post-tool | `PostToolUse` + `PostToolUseFailure` (`Bash`) | context, observe — outcome `split-events` |
| stop | `Stop` | **block**, context — `stopRefusal: 'block'` |
| post-compaction | — | declared gap: `PostCompact` exists upstream, unwired |
| permission | — | declared gap: `PermissionRequest` exists upstream, unwired |

Two declared gaps are deliberate, not oversights: wiring
`PostCompact` would double-inject rehydration next to
`SessionStart`-compact matchers already covered, and
`PermissionRequest` stays the user's plane — bro's self-tool
approve is a Cursor/Codex/Devin convenience, not a Claude promise.

### Native functions leveraged

- **Agent Skills** — the portable `skills/` tree installs through
  the plugin manifest; Claude is the reference client for
  agentskills.io, so bro's 49 skills reach the model with zero
  adaptation.
- **`CLAUDE.md` → `AGENTS.md`** compatibility — policy specs
  (AGENTS.md) are read literally; the `bro:sdd` identity region
  needs no Claude-specific handling.
- **Hook schema** — `matcher`, `type: command`, `timeout`, and the
  `${CLAUDE_PLUGIN_ROOT}` variable are Claude's own contract;
  run.sh honors it verbatim.
- **Stop block** — the only manifest host besides Codex/Devin where
  bro's gate is *enforced* by the host, not reprompted. The one-shot
  rule (`stop_hook_active`-equivalent marker) keeps it a gate, not
  a loop.

### Install

`/plugin marketplace add ThePlenkov/bro` → `/plugin install bro@bro`.
The marketplace manifest lives at the repo root; no per-client
artifact is generated for Claude beyond the hooks map.

## Requirements

- **R1** — All eight wired events keep their matrix cells; the two
  declared gaps stay declared (a gap that silently fills is drift).
- **R2** — `PostToolUse`/`PostToolUseFailure` split must keep
  feeding `outcome: 'split-events'` — the journal's `ok` field and
  the arm predicate both read it.
- **R3** — Stop `decision:block` stays one-shot per armed aspect;
  a repeated stop passes (gates, not loops).
- **R4** — Skills arrive only through the plugin manifest — no
  second `skills/` copy, no symlink tree (AGENTS.md portable-package
  rule).
- **R5** — `BRO_HOOKS=0` and missing-CLI paths stay fail-open: a
  wedged bro never stalls a Claude session.

## Verify

- `host-matrix.test.ts` claude row green; `hooks.e2e.test.ts`
  Claude payload shapes.
- Live: a Claude Code session in a bro-enabled repo shows
  rehydration context on start, an SDD nudge on prompt, and a
  single stop-gate block on an armed claim.
- `bro spec check`/`drift` unchanged — the host is transport, not
  policy.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: manifest surface, split
  post-tool outcome, real stop block; PostCompact/PermissionRequest
  recorded as declared gaps.
