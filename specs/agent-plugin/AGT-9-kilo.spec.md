---
template: brotocol/spec@2
id: AGT-9
title: Kilo — plugin bus, write-capable bro tool, notify-only stop, context transform
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/kilo/
  - packages/agent-plugins/kilo/
aliases:
  - kilo
---

# AGT-9 — Kilo: plugin bus, write-capable bro tool, notify-only stop, context transform

## Problem

Kilo (`@kilocode/plugin`) sits on the plugin bus but at the
**floor tier**: no widget, no command surface, no skill registry —
the only host where the model gets a *write-capable* bro tool
(`sub` + `args` → any subcommand) while the stop gate degrades to
`session.idle → notify`. The spec pins the bus contract, the
tool-vs-command asymmetry, and the honest enforcement gap.

## Design

### Surface: `plugin`, async, generated `bro.ts`

`plugins/kilo/bro/bro.ts` from `packages/agent-plugins/kilo/src/kilo.ts`
— `@kilocode/plugin` API, raw `.ts` load. Install:
`bro plugins install kilo [--global|--local]` → kilo plugin dir.

### Event mapping (HOOK_MATRIX `kilo` row)

| bro event | Kilo native | effects |
| --------- | ----------- | ------- |
| session-start + prompt-submit | `experimental.chat.system.transform` | context — **one shared transform**, dedup inside binding |
| permission | `permission.ask` | approve |
| stop | `event` → `session.idle` | **notify only** — `stopRefusal: 'none'` |
| pre-compact / post-compaction | — | gap |
| pre-tool | — | gap |
| post-tool | — | gap |

`nativeOnly`: `session.created`, `session.deleted`, `tool.bro`.

### What the plugin adds — the inventory

| asset | mechanism |
| ----- | --------- |
| `bro` tool | **write-capable** — `{sub, args[]}` → `bro <sub> <args…>`; the model invokes any subcommand (act, debt, drill, convoy, work, stack, next, loop, plan, plugins…). The ONE host where bro is model-callable beyond reads |
| `/bro` command | **none** — kilo has no command slot wired |
| `bro_*` read tools | **none** — the single `bro` tool replaces the read-namespace pattern |
| skills | no host registry wired — skills reach the model via `~/.agents/skills/` (`bro skills sync`) only |
| UX | `session.idle` → warn-log notify; no widget, no toast, no keymap |
| self-tool guard | `nativeOnly` patterns keep `tool.bro`/`session.*` out of bro's own probes (no self-trigger loops) |

### The stop-gate honesty

`session.idle` fires *after* settle — bro can only notify
(`stopRefusal: 'none'`). The gate's armed aspects still compute
and drain the mailbox, but nothing halts Kilo's stop. Declared
gap, not hidden: kilo is the contract's notify-tier floor, and
the spec says enforcement there is advisory-by-construction.

### Native correlation

Kilo's native tools/commands stay native; `bro` is one namespaced
tool, never a host-verb override. The shared `system.transform`
carries both session-start and prompt-submit context — the
binding dedups so hydration injects once.

## Requirements

- **R1** — `bro` tool stays write-capable with `{sub, args}` —
  read-pinning belongs to opencode's `bro_*` namespace, not kilo.
- **R2** — `system.transform` dedup preserved — hydration once per
  session, nudge per prompt.
- **R3** — Stop stays notify-only; never claim block on kilo.
- **R4** — `nativeOnly` patterns keep bro's own events out of
  probes (no recursion).
- **R5** — `plugins/kilo/bro/bro.ts` stays generated.
- **R6** — No `/bro`/widget/skill-registry claimed — assets are
  tool + context + permission + notify.

## Verify

- `host-matrix.test.ts` kilo row; adapter tests; `check:plugins`.
- Live: `bro` tool callable with subcommand args, transform
  injection visible, idle notify fires, no stop block attempted.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: bro tool contract (write-capable),
  shared-transform dedup, notify-only stop honesty, nativeOnly
  recursion guard.
