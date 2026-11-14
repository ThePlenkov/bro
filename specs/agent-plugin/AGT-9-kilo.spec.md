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
`bro plugins install kilo [--global|--local]` → kilo's scanned plugin
dir: `~/.config/kilo/plugin/bro.ts` / `.kilo/plugin/bro.ts`. kilo.json's
`plugin` array does **not** honor file paths (verified against kilo
7.8.x — `file://` and plain-path entries both load nothing); npm-package
entries are a different mechanism bro does not use.

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
- e2e: `bro-command.e2e.test.ts` kilo leg — model tool_call
  `{sub:'next', args:['--json']}` reaches FakeBro as
  `command ['next','--json']` + session-start hooks (S4 verified).

- **Scenario map** (AGT-1 §Test scenarios): applicable — S1
  session-start ctx, S4 `bro` tool dispatch (write-capable
  `sub`+`args` — the only write tool in the family), S7
  fail-open, S9 skills, S10 native correlation. Not applicable —
  S3 stop gate (`stopRefusal:'none'` — notify-only by design,
  declared gap), S2 pending driver. Pending — S5/S6/S8.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: bro tool contract (write-capable),
  shared-transform dedup, notify-only stop honesty, nativeOnly
  recursion guard.
- 2026-11-12 — v3: `bro.ts` now ships as a `bundleAdapter` bundle
  over `adapter-core` (`@kilocode/plugin` external). The two-tier
  local-dist/PATH ladder is replaced by the shared ladder — sibling,
  checkout, PATH, and now the npx fallback (`@broject/bro@<pin>` then
  latest) the old doc claimed but the code never had. Hook parsing
  takes the first control line like every adapter (was last-line);
  the dead `BRO_HOOK_INPUT` env is gone; tool runs share
  `RUN_TIMEOUT_MS`.
- 2026-11-12 — v4: Verify gains the AGT-1 scenario map; S3 declared not-applicable (notify-only stop).
- 2026-11-14 — v5: install surface corrected — global target moved
  `kilo/bro.ts` + kilo.json `file://` registration → scanned
  `plugin/bro.ts` (kilo ignores file paths in the `plugin` array;
  e2e caught a silently-dead install). Artifact resolution now prefers
  the self-contained `plugins/kilo/bro/bro.ts` bundle over adapter
  src (unresolvable `@broject/adapter-core` import outside the
  monorepo). S4 verified e2e via the `bro` tool matrix leg.
