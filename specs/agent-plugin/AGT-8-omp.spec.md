---
template: brotocol/spec@2
id: AGT-8
title: omp — extension surface, mode bridges, native stop block, /bro + bro_status
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/omp/
  - packages/agent-plugins/omp/
aliases:
  - omp
---

# AGT-8 — omp: extension surface, mode bridges, native stop block, /bro + bro_status

## Problem

omp is pi's sibling on the same adapter-core but the only host with
**native stop blocking** (`session_stop → decision:block` +
`stop_hook_active` round-trip) and **named modes** (Plan, Goal, Vibe,
Prewalk, Advisor) bro bridges rather than reimplements. The spec pins
the extension contract, `modes.ts` as the correlation contract, and
the one host where stop refusal is `'block'` — real enforcement.

## Design

### Surface: `extension`, async, generated `bro.ts`

`plugins/omp/bro/` materialized by bundle-adapter from
`packages/agent-plugins/omp/src/omp.ts` (+ `modes.ts`, `pre/`,
`permission.ts`). Same raw-`.ts`-via-jiti loading as pi; `bro plugins
install omp` or `omp plugin install`.

### Event mapping (HOOK_MATRIX `omp` row)

| bro event | omp native | effects |
| --------- | ---------- | ------- |
| session-start | `session_start` | context, notify |
| pre-compact | `session_before_compact` | context |
| post-compaction | `session_compact` | context |
| prompt-submit | `before_agent_start` | context |
| pre-tool | `tool_call` (separate binding) | block only — `force-push` guard |
| post-tool | `tool_result` | context, observe — `synthesized` |
| permission | `permission` hook | approve — `permission.ts` |
| stop | `session_stop` | **block** — native refusal + `stop_hook_active` |
| post-compaction | `session_compact` | context |

`nativeOnly`: `turn_end`, `session_shutdown`, `agent_settled`,
`plan_review_requested`, `goal_updated`, `before_subagent_spawn`.

### What the plugin adds — the inventory

| asset | mechanism |
| ----- | --------- |
| `/bro` | shared driver: bare → board refresh; args → `bro <args>` transcript |
| `bro_status` tool | `bro status --json` read tool |
| board widget | `setWidget`/`setStatus` — same paint path as pi |
| UX | hidden `inject()` context, `notify` toasts, mode-bridge injections |
| mode bridges | `modes.ts` injects claims/specs/judge/debt into Plan, Goal, Vibe, Prewalk, Advisor modes — omp keeps the mode UX, bro supplies the durable state |
| `WATCHDOG.md` | Advisor-mode watchdog doc materialized beside the plugin |
| permission | `permission.ts` — scoped approve |

### Stop gate — the only native block

`session_stop` returns `decision:block` + reason; `stop_hook_active`
round-trips so the once-per-aspect rule survives. omp is the
reference `StopRefusal: 'block'` host — where pi/opencode reprompt,
omp halts the settle.

### Native correlation — modes are bridges, not reimplementations

omp owns mode UX; `modes.ts` maps each mode to the bro state it
needs (Plan→claims+specs, Goal→goal beads, Advisor→judge+debt,
Prewalk→drill frames). No second "plan mode" — bro feeds the native
one.

## Requirements

- **R1** — `session_stop → decision:block` stays native; never
  downgrade to reprompt.
- **R2** — `stop_hook_active` round-trip preserved — no double-block.
- **R3** — Mode bridges inject state only; omp mode semantics
  unchanged.
- **R4** — `tool_call` stays block-only (`force-push` guard) —
  same unwired-input-override rule as pi.
- **R5** — `plugins/omp/bro/` stays generated; `check:plugins`.
- **R6** — `/bro` + `bro_status` semantics match AGT-1's shared
  driver contract exactly.

## Verify

- `host-matrix.test.ts` omp row; adapter tests; `check:plugins`.
- Live: native stop block on armed claim, mode-bridge injections
  visible in each mode, `/bro` passthrough, widget paint.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: full asset inventory, mode-bridge
  correlation contract, native stop-block mechanics.
