---
template: brotocol/spec@2
id: AGT-5
title: Devin — manifest surface, project-local hook-chain ownership, PostCompaction
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/devin/
aliases:
  - devin
---

# AGT-5 — Devin: manifest surface, project-local hook-chain ownership, PostCompaction

## Problem

Devin is the host this repo develops on and the reference
agent-plugins.org manifest client. Its distinguishing feature is
the **project-local hook chain**: a target repo's
`.devin/hooks.v1.json` can own an event, and `run.sh` must detect and
defer — the contract's first hook-ownership negotiation. Plus
`PostCompaction` (post-, not pre-) and `tool_response.success`
verbatim. No command/tool surface — context + skills + permission.

## Design

### Surface: `manifest`, sync

`plugins/devin/bro/` = `plugin.json` + `hooks.json` + `hooks/run.sh`,
generated from repo-root sources. Install:
`devin plugins install ThePlenkov/bro`. `${DEVIN_PLUGIN_ROOT}` root
var; run.sh accepts `PLUGIN_ROOT`/`CURSOR_PLUGIN_ROOT`/
`CLAUDE_PLUGIN_ROOT` fallbacks.

### Event mapping (HOOK_MATRIX `devin` row)

| bro event | Devin native | effects |
| --------- | ------------ | ------- |
| session-start | `SessionStart` | context |
| post-compaction | `PostCompaction` | context |
| prompt-submit | `UserPromptSubmit` | context |
| post-tool | `PostToolUse` (`^exec$`) | context, observe — `field` (`tool_response.success`) |
| permission | `PermissionRequest` (`^exec$`) | approve |
| stop | `Stop` | block, context |
| pre-compact | — | gap (PostCompaction covers rehydration) |
| pre-tool | — | gap |

### Project-local chain ownership — the Devin rule

`project_devin_hook_owns_event`: when the target repo's
`.devin/hooks.v1.json` registers `hooks/run.sh <event>`, the
plugin-installed copy exits for THAT event only — the project's own
chain owns it. Checks: event-scoped, path-scoped
(`SCRIPT_ROOT != DEVIN_PROJECT_ROOT`), fail-closed toward no
double-fire. Two bro installs (global plugin + project-vendored)
must never both answer one event — the contract's hook-ownership
negotiation; future layered-install hosts inherit it.

### What the plugin adds — the honest inventory

| asset | Devin gets | mechanism |
| ----- | ---------- | --------- |
| `/bro` command | **none** | n/a |
| `bro_*` tools | **none** | n/a |
| skills | all 49 | plugin `skills/` via devin plugin install |
| UX | hook context lines | rehydration/nudges; PostCompaction re-fires the snapshot |
| permission | `PermissionRequest` (`^exec$`) approve | self-tools |

### Native correlation

- **agent-plugins.org `plugin.json`** — Devin is the reference
  client; schema/keywords/hooks layout are the portable contract.
- **`PostCompaction`** — compaction reported *after*; rehydration
  rides the post-event (no pre-compact mark-clearing needed).
- **`tool_response.success`** — only manifest host carrying outcome
  verbatim (`outcome: 'field'`).
- **`^exec$` matcher** — hook volume stays on shell calls.
- Native Devin commands/skills stay native; bro = hooks + skills.

## Requirements

- **R1** — `project_devin_hook_owns_event` stays event+path scoped;
  a project chain owning `stop` must not silence `session-start`,
  and a foreign `hooks/run.sh` outside the project root must not
  claim ownership.
- **R2** — `plugins/devin/bro/` stays generated.
- **R3** — `outcome: 'field'` preserved — journal reads
  `tool_response.success` verbatim.
- **R4** — PostCompaction rehydration semantics preserved.
- **R5** — Stop block one-shot; `stopRefusal: 'block'`.
- **R6** — No `/bro`/tools claimed.

## Verify

- `host-matrix.test.ts` devin row; `check:plugins` clean;
  `hooks.e2e.test.ts` Devin payload shapes.
- Live: this repo's own Devin sessions — rehydration, exec post-tool
  arming, single stop-gate block.
- Ownership fixture: `.devin/hooks.v1.json` repo shows the plugin
  copy deferring exactly the registered events.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: assets inventory, hook-ownership rule
  promoted to contract, PostCompaction/field-outcome noted.
