---
template: brotocol/spec@2
id: AGT-7
title: pi — extension surface, /bro + bro_status, settle-gate reprompt, unwired tool_call
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/pi/
  - packages/agent-plugins/pi/
aliases:
  - pi
---

# AGT-7 — pi: extension surface, /bro + bro_status, settle-gate reprompt, unwired tool_call

## Problem

pi (`@earendil-works/pi-coding-agent`) is the host adapter-core was
built for — its extension API is the reference `BroHostBinding`
abstracts. The spec pins the extension contract: event mapping, the
shared `/bro`+`bro_status` assets, the settle-gate reprompt (the
canonical no-refusal pattern), and `tool_call`'s *deliberate*
unwired state.

## Design

### Surface: `extension`, async, single generated file

`plugins/pi/bro/bro.ts` generated from
`packages/agent-plugins/pi/src/pi.ts` (adapter-core folded by
bundle-adapter — node builtins only). Pi loads raw `.ts` via jiti —
no build, no node_modules. Install: `bro plugins install pi` →
`~/.pi/agent/extensions/bro.ts` or `.pi/extensions/bro.ts`; ad hoc
`pi --extension <path>`.

### Event mapping (HOOK_MATRIX `pi` row)

| bro event | pi native | effects |
| --------- | --------- | ------- |
| session-start | `session_start` | context, notify |
| pre-compact | `session_before_compact` | context |
| post-compaction | `session_compact` | context |
| prompt-submit | `before_agent_start` | context |
| post-tool | `tool_result` | context, observe — `synthesized` (`isError`) |
| stop | `agent_before_settle` | reprompt, context — `stopRefusal: 'reprompt'` |
| pre-tool | — | **deliberate**: `tool_call` is block-only; bro's lane is input-override — a block-only slot would lie |
| permission | — | gap |

`nativeOnly`: `turn_end`, `session_shutdown`, `agent_settled`.

### What the plugin adds — the inventory

| asset | mechanism |
| ----- | --------- |
| `/bro` | shared driver command: bare → `refreshBoard` + notify 'board refreshed'; args → `bro <args>` → transcript `bro-output` message (`display:true`, `triggerTurn:false`); nonzero → error notify; `argumentCompletions` optional |
| `bro_status` tool | `bro status --json` → board JSON as tool result — the model-callable read |
| board widget | `ctx.ui.setWidget`/`setStatus` renders `bro status --json` on session start, turn end, agent settle; `canPaint` gates interactive-only |
| UX | hidden context injection (`inject()` → pi hidden message — hydration+nudge land as one before agent start), `notify` toasts |

### Settle gate — the canonical reprompt

`agent_before_settle` has no refusal slot → driver answers
`continue:true` + visible `custom_message` with the blocker, once
per session (local `stopAlreadyRefused` flag — pi reports no
`stop_hook_active`). AGT-1's reference `StopRefusal: 'reprompt'`.

### Native correlation

pi's own commands/extensions stay native; `/bro` is additive,
`bro_status` is a read tool, the widget is paint-only. No mode
bridges (omp owns that pattern).

### Install

`bro plugins install pi [--global|--local]`; CLI ladder: local
dist → `bro` PATH → `npx -y --prefer-offline @broject/bro@<pin>`.
All calls async + fail-open.

## Requirements

- **R1** — `tool_call` stays unwired — block-only can't express
  input-override; wiring it is a contract violation until pi grows
  the slot.
- **R2** — Settle gate once-per-session reprompt; local
  `stopAlreadyRefused` mirrors the driver's one-shot rule.
- **R3** — `bro.ts` stays generated; `check:plugins` clean.
- **R4** — Widget/`/bro`/`bro_status` silent when `canPaint` false.
- **R5** — `outcome: 'synthesized'` from `isError` — no invented
  success field.

## Verify

- `host-matrix.test.ts` pi row; adapter tests; `check:plugins`.
- Live: board widget, hidden hydration, `/bro` output,
  `bro_status` result, one settle-gate reprompt on armed claim.

- **Scenario map** (AGT-1 §Test scenarios): applicable — S1
  session-start ctx, S3 stop gate (settle reprompt), S4 `/bro`
  dispatch + `bro_status` tool (verified e2e — RPC `prompt` →
  `disposition:"handled"`, `bro <args>` argv in FakeBro journal,
  `bro-command.e2e.test.ts`), S7 fail-open, S9 skills, S10
  native correlation. Not applicable — S2 pre-tool guard
  (`tool_call` event unwired — declared gap). Pending — S5/S6/
  S8 driver verification.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: /bro dispatcher semantics, bro_status
  tool, widget lifecycle, settle-gate one-shot mechanics.
- 2026-11-12 — v3: Verify gains the AGT-1 scenario map; S2 declared not-applicable (tool_call unwired).
- 2026-11-14 — v4: S4 `/bro` dispatch verified e2e — RPC `prompt`
  leg of `bro-command.e2e.test.ts` asserts `disposition:"handled"`,
  identical `bro <args>` argv, session-start hook in the journal.
