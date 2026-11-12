---
template: brotocol/spec@2
id: AGT-4
title: Cursor — generated manifest, reprompt-only stop, mandatory permission answer
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/cursor/
aliases:
  - cursor
---

# AGT-4 — Cursor: generated manifest, reprompt-only stop, mandatory permission answer

## Problem

Cursor's hook schema is the most opinionated of the manifest hosts:
`beforeShellExecution` treats **empty reply as deny**, `stop` takes
one `followup_message` (`loop_limit: 1`), cloud agents never fire
`sessionStart`. The adapter is *generated* — the spec pins the
artifact contract and the three Cursor semantics that make it
non-copyable from the Claude manifest.

## Design

### Surface: `generated`, sync

`plugins/cursor/bro/` materialized by `gen-plugins.ts`
(`.cursor-plugin/plugin.json` + `hooks/hooks.json`); `check:plugins`
fails on drift. Hooks speak Cursor schema — `additional_context`,
`followup_message`, `permission`; `bro hooks` translates stdin
(`conversation_id`, `loop_count`, shell `command`).

### Event mapping (HOOK_MATRIX `cursor` row)

| bro event | Cursor native | effects |
| --------- | ------------- | ------- |
| session-start | `sessionStart` | context |
| pre-compact | `preCompact` | context |
| prompt-submit | `beforeSubmitPrompt` | context |
| post-tool | `postToolUse` + `postToolUseFailure` (`^Shell$`) | context, observe — `mapped` |
| stop | `stop` | reprompt (`loop_limit: 1`), context |
| permission | `beforeShellExecution` (`CURSOR_SELF_TOOL_MATCHER`) | approve — **mandatory answer** |
| post-compaction | — | gap |
| pre-tool | — | gap |

### The three Cursor semantics (contract-level)

1. **Empty reply = deny.** `beforeShellExecution` must ALWAYS
   answer — even unopted — because silence blocks. Plain
   `bro`/`bd`/`npx @broject/bro` approves; chained commands stay
   prompts. The one event where fail-open inverts: the *answer* is
   mandatory, its content stays conservative.
2. **No `sessionStart` on cloud.** Cloud sessions skip the start
   hook → first `beforeSubmitPrompt` rehydrates once (reuses the
   session-start snapshot), `preCompact` clears the mark. The
   contract's cloud-agent fallback — every partial-coverage host
   inherits it.
3. **`loop_limit: 1` stop.** No refusal slot: gate `decision:block`
   → exactly one `followup_message`, turn ends regardless.
   `stopRefusal: 'reprompt'` — enforcement is advisory-by-construction
   and the spec says so.

### What the plugin adds — the honest inventory

| asset | Cursor gets | mechanism |
| ----- | ----------- | --------- |
| `/bro` command | **none** | n/a |
| `bro_*` tools | **none** | n/a |
| skills | all 49 | plugin `skills/` link inside `plugins/cursor/bro` → repo `skills/` (must stay inside checkout) |
| UX | `additional_context` lines, one `followup_message` on stop, permission prompts | hook outputs only |
| permission | `beforeShellExecution` approve | self-tools; mandatory-answer rule above |

### Native correlation

Cursor rules/commands stay native; bro's surface is hooks+skills.
The cloud-agent rehydration path is the only place bro compensates
for a missing native event — declared, not hidden.

### Install

`/add-plugin https://github.com/ThePlenkov/bro` → install `bro`;
marketplace `.cursor-plugin/marketplace.json` → `plugins/cursor/bro`.
Local: symlink into `~/.cursor/plugins/local/bro` (skills link must
resolve inside the checkout).

## Requirements

- **R1** — `beforeShellExecution` always answers; unopted workspaces
  get the conservative triple — never empty.
- **R2** — Cloud rehydration: first `beforeSubmitPrompt` hydrates
  once when `sessionStart` never ran; `preCompact` resets.
- **R3** — Stop stays `loop_limit: 1`; `stopRefusal: 'reprompt'`
  remains declared.
- **R4** — `plugins/cursor/bro/` stays generated — edits land in
  sources, `check:plugins` enforces.
- **R5** — `mapped` outcome preserved — edge translator turns split
  native events into one normalized outcome.
- **R6** — No `/bro`/tools claimed.

## Verify

- `host-matrix.test.ts` cursor row; `check:plugins` clean;
  `hooks.e2e.test.ts` Cursor payload translation.
- Live: first-prompt rehydration (cloud path), `bro` shell auto-
  approve, gated stop → exactly one follow-up.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: assets inventory, mandatory-answer rule
  promoted to contract-level, cloud fallback named.
