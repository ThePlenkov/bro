---
template: brotocol/spec@2
id: AGT-7
title: pi — extension surface, settle-gate reprompt, deliberately unwired tool_call
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/pi/
  - packages/agent-plugins/pi/
aliases:
  - pi
---

# AGT-7 — pi: extension surface, settle-gate reprompt, deliberately unwired tool_call

## Problem

pi (`@earendil-works/pi-coding-agent`) is the host the adapter-core
framework was built for — its extension API is the reference shape
`BroHostBinding` abstracts. The spec pins the extension contract:
which pi events map to bro events, why `tool_call` is *deliberately
unwired* (a designed absence, not a gap), and how the settle gate
reprompts without a refusal slot.

## Design

### Surface: `extension`, async, single-file module

`plugins/pi/bro/bro.ts` is generated from
`packages/agent-plugins/pi/src/pi.ts` — the shared adapter core
(`adapter-core/src/core.ts` + `host.ts` driver) folded into one
self-contained file (node builtins only) by `scripts/bundle-adapter.ts`.
Pi discovers it via jiti — raw `.ts`, no build, no `node_modules`
required. Install: `bro plugins install pi` →
`~/.pi/agent/extensions/bro.ts` (global) or `.pi/extensions/bro.ts`
(local); ad hoc via `pi --extension <path>`.

### Event mapping (HOOK_MATRIX `pi` row)

| bro event | pi native | effects |
| --------- | --------- | ------- |
| session-start | `session_start` | context, notify |
| pre-compact | `session_before_compact` | context |
| post-compaction | `session_compact` | context |
| prompt-submit | `before_agent_start` | context |
| post-tool | `tool_result` | context, observe — outcome `synthesized` (`isError`) |
| stop | `agent_before_settle` | reprompt, context — `stopRefusal: 'reprompt'` |
| pre-tool | — | **deliberate**: `tool_call` can only block; bro's pre-tool lane is input-override — a block-only slot would lie |
| permission | — | declared gap |

`nativeOnly`: `turn_end`, `session_shutdown`, `agent_settled` — pi
events bro observes for board refresh but that carry no hook payload.

### The settle gate (canonical reprompt)

`agent_before_settle` has no refusal slot: the driver answers
`continue: true` plus a visible `custom_message` carrying the
blocker, once per session — the model sees the gate reason as a
user-role message and the turn continues. `stopAlreadyRefused` is a
local flag (pi does not report `stop_hook_active` like omp). This is
the reference implementation of "host cannot refuse → reprompt",
which AGT-1 names as a first-class `StopRefusal` mode.

### Native functions leveraged

- **TUI board widget** — `ctx.ui.setWidget`/`setStatus` renders
  `bro status --json` on session start, turn end, and agent settle;
  `canPaint` gates it to interactive sessions.
- **`/bro` command** — bare refreshes the board; `/bro act|next|
  fleet|…` runs the CLI into the transcript, with `argumentCompletions`
  for subcommands.
- **`bro_status` tool** — the board JSON as a model-callable read.
- **Hidden context injection** — `inject()` builds pi's hidden
  context message; hydration + nudge land as one message before the
  agent starts.
- **jiti raw-TS loading** — no build step, no package install inside
  the host; the self-contained-file constraint of adapter-core exists
  precisely for this loader.

### Install

`bro plugins install pi [--global|--local]`; resolution ladder:
local dist (bundled sibling or checkout `packages/cli/dist`), `bro`
on PATH, `npx -y --prefer-offline @broject/bro@<pin>`. Every call
async and fail-open.

## Requirements

- **R1** — `tool_call` stays unwired — the day pi grows an
  input-override slot, this spec changes; until then wiring a
  block-only slot is a contract violation, not an improvement.
- **R2** — Settle gate stays once-per-session reprompt; the local
  `stopAlreadyRefused` flag must mirror the driver's one-shot rule.
- **R3** — `plugins/pi/bro/bro.ts` stays generated — sources in
  `packages/agent-plugins/pi/src/pi.ts` + `adapter-core/`; drift
  fails `check:plugins`.
- **R4** — Board widget, `/bro`, `bro_status` keep working with no
  interactive TTY (`canPaint` false → silent).
- **R5** — `outcome: 'synthesized'` from `isError` — pi reports no
  success field; never invent one.

## Verify

- `host-matrix.test.ts` pi row green; adapter unit tests +
  `check:plugins` clean.
- `hooks.e2e.test.ts` normalized payload shapes the extension sends.
- Live: pi session shows board widget, hidden hydration message,
  `/bro` output, `bro_status` tool result, one settle-gate reprompt
  on an armed claim.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: extension surface,
  settle-gate reprompt as canonical no-refusal pattern, tool_call
  deliberate absence recorded.
