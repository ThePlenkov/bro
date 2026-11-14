---
template: brotocol/spec@2
id: AGT-2
title: Claude Code — manifest surface, split post-tool, real stop block, skills-only assets
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/claude/
aliases:
  - claude
---

# AGT-2 — Claude Code: manifest surface, split post-tool, real stop block, skills-only assets

## Problem

Claude Code is bro's oldest host and richest manifest surface: the
repo root IS the plugin (`.claude-plugin/plugin.json` + `skills/`),
`plugins/claude/bro/hooks/hooks.json` wires eight native events to
`run.sh`. It has a real `Stop → decision:block` and a split post-tool
outcome — but **no command or tool surface**: bro reaches the model
only through hook context + skills. The spec pins the mapping, the
two declared gaps, and the assets-absence declaration.

## Design

### Surface: `manifest`, sync, repo-root plugin

`hooks.json` pipes stdin → `${CLAUDE_PLUGIN_ROOT}/hooks/run.sh
<event>`; run.sh resolves CLI (checkout dist → `bro` PATH), bounds
every call, exits 0 on failure.

### Event mapping (HOOK_MATRIX `claude` row)

| bro event | Claude native | effects |
| --------- | ------------- | ------- |
| session-start | `SessionStart` | context |
| pre-compact | `PreCompact` | context |
| prompt-submit | `UserPromptSubmit` | context |
| pre-tool | `PreToolUse` (`Bash`) | block, rewrite |
| post-tool | `PostToolUse` + `PostToolUseFailure` (`Bash`) | context, observe — `split-events` |
| stop | `Stop` | **block**, context |
| post-compaction | — | gap: `PostCompact` exists upstream, unwired |
| permission | — | gap: `PermissionRequest` exists upstream, unwired |

### What the plugin adds — the honest inventory

| asset | Claude gets | mechanism |
| ----- | ----------- | --------- |
| `/bro` command | **none** — no command slot wired | n/a |
| `bro_*` tools | **none** | n/a |
| skills | all 49 | plugin `skills/` at repo root — Claude is the agentskills.io reference client |
| UX | hook `additional_context` lines only | session-start/prompt nudges, stop-gate block reason |
| permission | — | declared gap (self-tool approve unwired) |

This is the contract's **context+skills tier**: enforcement exists
(stop block, pre-tool veto) but discovery is entirely through skills
— the model invokes `act`/`drill`/`loop` by skill name, never by a
`/bro` verb.

### Native correlation

- **`CLAUDE.md` → `AGENTS.md`** — policy specs read literally; the
  `bro:sdd` identity region needs no shim.
- **Agent Skills / slash skills** — bro's 49 skills ARE Claude
  skills; no translation layer.
- **Native commands** (`/init`, `/review`, custom commands,
  subagents) — bro does not shadow them; skills cover bro workflows,
  native commands keep session work.
- **Stop block** — real enforcement: `decision:block` halts the
  stop, one-shot per armed aspect.

### Install

`/plugin marketplace add ThePlenkov/bro` → `/plugin install
bro@bro`. No generated artifact beyond hooks.json.

## Requirements

- **R1** — All wired cells keep matrix semantics; the two gaps stay
  declared (PostCompact would double-inject; PermissionRequest
  stays the user's plane).
- **R2** — `split-events` outcome preserved — journal `ok` and arm
  predicate read it.
- **R3** — Stop block one-shot per armed aspect.
- **R4** — Skills only via plugin manifest — no second `skills/`
  copy (portable-package rule).
- **R5** — Fail-open everywhere: `BRO_HOOKS=0`, missing CLI,
  timeout → no opinion, never a stall.
- **R6** — No `/bro`/tools may be claimed for Claude — if a command
  surface appears upstream, this spec gains a row, not a silent
  wiring.

## Verify

- `host-matrix.test.ts` claude row; `hooks.e2e.test.ts` Claude
  payload shapes.
- Live: rehydration on start, SDD nudge on prompt, single stop-gate
  block on armed claim, skills invocable by name.

- **Scenario map** (AGT-1 §Test scenarios): applicable — S1
  session-start ctx (SessionStart/UserPromptSubmit), S2 pre-tool
  deny (PreToolUse → tool result), S3 stop block (native Stop
  hook — strongest cell in the family), S7 fail-open (`run.sh`
  chain), S8 dep-degraded, S9 skills (full set via plugin),
  S10 native correlation. Not applicable — S4 `/bro` (no command
  surface by design), S6 per-turn sequence (manifest hooks are
  event-driven, not turn-scoped), S5 compaction (no compaction
  event on this host). Hook dispatch verified e2e —
  `manifest.e2e.test.ts` fires every hooks.json-declared event
  through the shipped run.sh and asserts `bro hooks <event>` +
  payload in the FakeBro journal. Pending — live claude-binary
  driver.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: added assets-absence declaration
  (no /bro, no tools), skills-only delivery, native-correlation
  notes.
- 2026-11-12 — v3: Verify gains the AGT-1 scenario map (S1–S10 applicability); catalog is contract per R7/R8.
- 2026-11-14 — v4: hook dispatch verified e2e — `manifest.e2e.test.ts`
  fires every hooks.json-declared event through the shipped run.sh
  into a fixture plugin root; FakeBro journal asserts `bro hooks
  <event>` + payload per event. Live claude-binary driver still pending.
