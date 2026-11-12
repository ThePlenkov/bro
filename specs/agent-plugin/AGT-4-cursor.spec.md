---
template: brotocol/spec@2
id: AGT-4
title: Cursor — generated manifest, reprompt-only stop, empty-reply-is-deny permission
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/cursor/
aliases:
  - cursor
---

# AGT-4 — Cursor: generated manifest, reprompt-only stop, empty-reply-is-deny permission

## Problem

Cursor's hook schema is the most opinionated of the manifest hosts:
`beforeShellExecution` treats an **empty reply as deny**, `stop`
accepts only a single `followup_message` (`loop_limit: 1`), and
cloud agents never fire `sessionStart` at all. The adapter is
*generated* (`gen-plugins.ts` → `plugins/cursor/bro/`), so the spec
must pin the generated-artifact contract and the three Cursor-specific
semantic translations — they are the reason this host cannot be a
copy of the Claude manifest.

## Design

### Surface: `generated`, sync

`plugins/cursor/bro/` is materialized by `scripts/gen-plugins.ts`
(`.cursor-plugin/plugin.json` + `hooks/hooks.json`); `check:plugins`
fails on drift. The hooks speak Cursor's schema — `additional_context`,
`followup_message`, `permission` — and `bro hooks` translates stdin
(`conversation_id`, `loop_count`, shell `command`) into the shared
contract.

### Event mapping (HOOK_MATRIX `cursor` row)

| bro event | Cursor native | effects |
| --------- | ------------- | ------- |
| session-start | `sessionStart` | context |
| pre-compact | `preCompact` | context |
| prompt-submit | `beforeSubmitPrompt` | context |
| post-tool | `postToolUse` + `postToolUseFailure` (`^Shell$`) | context, observe — outcome `mapped` |
| stop | `stop` | reprompt (`loop_limit: 1`), context — `stopRefusal: 'reprompt'` |
| permission | `beforeShellExecution` (`CURSOR_SELF_TOOL_MATCHER`) | approve |
| post-compaction | — | declared gap |
| pre-tool | — | declared gap |

### The three Cursor semantics (contract-level, not adapter trivia)

1. **Empty reply = deny.** `beforeShellExecution` must *always*
   answer — even in an unopted workspace — because silence blocks the
   command. A plain `bro`/`bd`/`npx @broject/bro` is approved; a
   chained command stays a prompt. This inverts the usual fail-open
   rule for exactly one event: the permission answer is mandatory,
   its *content* is what stays conservative.
2. **No `sessionStart` on cloud agents.** Cursor cloud sessions skip
   the start hook, so the first `beforeSubmitPrompt` rehydrates once
   (the cursor-hydrate leg reuses the session-start snapshot) and
   `preCompact` clears the mark. Rehydration-on-first-prompt is the
   contract's cloud-agent fallback — every future host with partial
   hook coverage inherits the same pattern.
3. **`loop_limit: 1` stop.** Cursor cannot refuse a stop; the gate's
   `decision:block` becomes exactly one `followup_message`, then the
   turn ends regardless. `stopRefusal: 'reprompt'` declares this —
   enforcement on Cursor is advisory-by-construction and the spec
   says so rather than pretending parity.

### Install

`/add-plugin https://github.com/ThePlenkov/bro` → install `bro` from
Customize; marketplace manifest `.cursor-plugin/marketplace.json`
sources `plugins/cursor/bro`. Local checkout: symlink into
`~/.cursor/plugins/local/bro` (the `skills` link must resolve inside
the checkout — the adapter cannot float free of the repo).

## Requirements

- **R1** — `beforeShellExecution` always answers; unopted workspaces
  still get the conservative approve/prompt triple — never empty.
- **R2** — Cloud-agent rehydration: first `beforeSubmitPrompt`
  hydrates once when `sessionStart` never ran; `preCompact` resets.
- **R3** — Stop stays `loop_limit: 1` — one follow-up, never a loop;
  `stopRefusal: 'reprompt'` remains the declared mode.
- **R4** — `plugins/cursor/bro/` stays generated — edits land in
  `packages/agent-plugins/` or `scripts/gen-plugins.ts`, never in the
  artifact (`check:plugins` enforces).
- **R5** — `postToolUse`/`postToolUseFailure` → `outcome: 'mapped'`
  keeps the edge-translator semantics (split native events → one
  normalized outcome).

## Verify

- `host-matrix.test.ts` cursor row green; `check:plugins` clean.
- `hooks.e2e.test.ts` Cursor payload translation (`conversation_id`,
  `loop_count`, shell `command`).
- Live: Cursor session rehydrates on first prompt (cloud path), a
  `bro` shell call auto-approves, a gated stop produces exactly one
  follow-up.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: generated surface, the
  empty-reply/cloud-agent/loop-limit semantics, reprompt-only stop.
