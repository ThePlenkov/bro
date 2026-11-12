---
template: brotocol/spec@2
id: AGT-6
title: OpenCode — v2 plugin bus, RPC channel, 8 bro_* tools, /bro + /act, TUI slots
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/opencode/
  - packages/agent-plugins/opencode/
aliases:
  - opencode
---

# AGT-6 — OpenCode: v2 plugin bus, RPC channel, 8 bro_* tools, /bro + /act, TUI slots

## Problem

OpenCode is the richest host — bro is a first-class *plugin* (server
+ TUI + RPC contract), the only host where the surface plane is
fully exercised: model tools, slash commands, skill registry, TUI
widgets, toasts, and a push channel. The spec pins the v2-only
surface (v1 hooks dead upstream), the `/bro`+`/act` command pair,
the 8-tool read namespace, and the RPC contract keeping TUI and
tools on one truth.

## Design

### Surface: `plugin`, async, catalog directory

`plugins/opencode/bro/` = three generated modules:
`index.ts` (server: hooks, tools, commands, skills, RPC),
`tui.tsx` (SolidJS/OpenTUI), `rpc.ts` (typed contract, also
`POST /api/rpc/bro/<method>`). Sources:
`packages/agent-plugins/opencode/src/`; `check:plugins` enforces.

### Event mapping (HOOK_MATRIX `opencode` row — v2 only)

| bro event | OpenCode v2 native | effects |
| --------- | ----------------- | ------- |
| session-start | `session.hook("context")` | context — hydrate once, re-push per request |
| prompt-submit | `session.hook("prompt")` | context — rides system ctx via pendingPromptContext |
| pre-compact | `session.hook("compaction")` | context |
| post-tool | `tool.execute.after` | context, observe — `synthesized` (`isError`) |
| pre-tool | `tool.execute.before` | block, rewrite — `tool_input` merges over original args |
| permission | `permission.hook("evaluate")` | approve — command joined from `resources` |
| stop | `event` → `session.idle` | reprompt, context — `stop_hook_active` skip |
| post-compaction | — | gap (compaction hook covers it) |

### What the plugin adds — the full inventory

| asset | mechanism |
| ----- | --------- |
| `/bro [args]` | quote-aware `splitArgs` (`"…"`/`'…'` hold multiword) → `core.exec(bro <args>)` → output submitted via `ctx.session.prompt` — **opencode's command idiom is prompt-submission, so the verb's output becomes the next turn's input**; bare defaults to `status`. Nonzero exit appends `(exit N)` |
| `/act` | `/bro act` shortcut — same prompt-submit path with `act` prepended |
| `bro_*` tools ×8 | read-verbs pinned to fixed argv: `status --json`, `convoy status`, `act status --json`, `fleet`, `next --list`, `work drill status`, `review act threads`, `status --json` (worktree) — model gets reads, never arbitrary bro |
| skills | registered into opencode's skill registry from plugin dir; installed copies also reach `~/.agents/skills/` (`bro skills sync`) — deduplicated by design |
| RPC | `board`, `notify`, `prompt` methods + `changed`, `attention` events — the push channel into the host |
| TUI | `sidebar.content` collapsible board, `session.panel` full-width, `bro.status`/`bro.board` keymaps, `attention` → toast + sound |
| `shell.env` | `nativeOnly` — env the host's shell tools inherit (beads env, hooks flags) |

### `/bro` + stop-gate specifics

- Stop: no pre-stop slot → `session.idle` delivers the blocker as
  ONE synthesized prompt (`reprompt` via `session.prompt`/
  `synthetic`), later idles skipped via persisted `stop-gated`
  storage + `stop_hook_active`. `stopRefusal: 'reprompt'`.
- Hydration: `context` hook pushes the snapshot into `event.system`
  once per session, re-pushed every model request (cache keeps it
  cheap); prompt nudges queue in `pendingPromptContext`.

### Native correlation

opencode's own commands/tools stay native — bro adds the `bro_*`
namespace + `/bro`/`/act`, never redefines host verbs. Skills join
the host registry rather than a parallel list.

### Install

`"plugin": ["@broject/bro"]` in `opencode.json`, or
`bro plugins install opencode [--global|--local]` → catalog dir in
`$XDG_CONFIG_HOME/opencode/plugins/bro/` or `.opencode/plugins/bro/`.
CLI resolution: local dist → `bro` PATH → `npx @broject/bro@0.3.0`.

## Requirements

- **R1** — v2 surface only; no v1 event names.
- **R2** — `rpc.ts` is the single typed boundary — TUI/server change
  together; HTTP method stays reachable.
- **R3** — Stop stays reprompt-once via `stop_hook_active` +
  persisted `stop-gated` set.
- **R4** — 8 `bro_*` tools keep pinned argv — reads only.
- **R5** — `/bro` quote-aware splitting preserved (`learn capture
  "a note"` must not shred).
- **R6** — Skills dedup: plugin-dir registration vs
  `~/.agents/skills/` never double-register.
- **R7** — `plugins/opencode/bro/` stays generated.

## Verify

- `host-matrix.test.ts` opencode row; adapter tests; `check:plugins`.
- Live (dogfooded in SDD work): `opencode run` sessions — hydration
  context, board widget, `bro_*` tools callable, `/bro` output,
  attention toasts; `POST /api/rpc/bro/board` returns board JSON.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: full asset inventory — /bro+/act commands,
  8 bro_* tools with pinned argv, skills dedup, RPC methods/events,
  TUI slots, shell.env.
- 2026-11-12 — v3: `index.ts` now ships as a `bundleAdapter` bundle
  (adapter-core folded, `@opencode/plugin` external, `rpc.ts`
  inlined — the emitted `rpc.ts` remains for `tui.tsx`). Local
  spawn/probe/parse helpers deleted; the shared CLI ladder now probes
  a pinned `options.command` like every other tier, tool/command
  reads run under `RUN_TIMEOUT_MS` (60s, was 15s), and resolution
  retries a failed answer after `RESOLVE_RETRY_MS`.
