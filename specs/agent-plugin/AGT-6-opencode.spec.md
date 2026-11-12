---
template: brotocol/spec@2
id: AGT-6
title: OpenCode — v2 plugin bus, RPC channel, TUI slots, bro tool namespace
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/opencode/
  - packages/agent-plugins/opencode/
aliases:
  - opencode
---

# AGT-6 — OpenCode: v2 plugin bus, RPC channel, TUI slots, bro tool namespace

## Problem

OpenCode is bro's richest host — the only one where bro is a
first-class *plugin* (server + TUI + RPC contract) rather than a
hook shim. It is also the host where the contract's surface plane
is exercised hardest: model-callable tools, slash commands, skill
registration, TUI widgets, toasts, and a push channel (`changed` /
`attention` events) all exist. The spec pins the v2-only surface
(v1 hooks are gone upstream) and the RPC contract that keeps the
TUI and the model tools from ever disagreeing.

## Design

### Surface: `plugin`, async, catalog directory

`plugins/opencode/bro/` is a **catalog plugin** — opencode loads a
plugin as a directory and raises the TUI half only for a package
that also has a server, so three generated modules ship together:

- `index.ts` — server half (`Plugin.define({id, setup})`): session
  hooks, tool guard + result enrichment, permission evaluate, shell
  env, the **bro tool namespace** (`bro_status`, `bro_convoy_status`,
  `bro_act_status`, `bro_fleet`, `bro_next`, `bro_drill_status`,
  `bro_review_threads`), `/bro` and `/act` commands, skills
  registered into opencode's skill registry, RPC registration.
- `tui.tsx` — SolidJS/OpenTUI half: `sidebar.content` collapsible
  board, `session.panel` full-width board, `bro.status`/`bro.board`
  keymaps, `attention` event → toast + sound.
- `rpc.ts` — the typed contract both halves share (`context.client
  .rpc(Bro)`; also reachable over HTTP `POST /api/rpc/bro/<method>`).

All three are generated from `packages/agent-plugins/opencode/src/`
by `gen-plugins.ts`; `check:plugins` fails on drift.

### Event mapping (HOOK_MATRIX `opencode` row — v2 names only)

| bro event | OpenCode v2 native | effects |
| --------- | ----------------- | ------- |
| session-start | `session.hook("context")` | context |
| prompt-submit | `session.hook("prompt")` | context |
| pre-compact | `session.hook("compaction")` | context |
| post-tool | `tool.execute.after` | context, observe — outcome `synthesized` (`isError`) |
| pre-tool | `tool.execute.before` | block, rewrite |
| permission | `permission.hook("evaluate")` | approve |
| stop | `event` → `session.idle` | reprompt, context — `stopRefusal: 'reprompt'` |
| post-compaction | — | declared gap (compaction hook covers the need) |

### Native functions leveraged — the reference host

- **No pre-stop slot → synthetic reprompt.** `session.idle` is the
  closest event; the first gate blocker re-enters as one synthesized
  prompt, later idles skip via `stop_hook_active`. This is the
  contract's canonical reprompt pattern — Cursor's `loop_limit` and
  pi's `continue:true` are the same shape with different spellings.
- **RPC as the state channel.** The TUI never spawns bro — the board
  arrives over RPC (`board`, `notify`, `prompt` methods; `changed`,
  `attention` events), so widget and model tools read one truth.
  This is the surface plane's fullest expression and the pattern
  future rich hosts should copy.
- **Tool namespace** — six `bro_*` tools give the model first-class
  reads (status, act, fleet, next, drill, review threads) instead of
  shelling out; the contract's "surface" plane made literal.
- **Skill registry** — bro's skills register into opencode's own
  registry from the plugin; installed-as-directory hosts also get
  them via `~/.agents/skills/` (`bro skills sync`) — the two paths
  are deduplicated by design.
- **`shell.env`** — `nativeOnly` cell: bro exports env the host's
  shell tools inherit (beads env, hooks flags).

### Install

`"plugin": ["@broject/bro"]` in `opencode.json`, or
`bro plugins install opencode [--global|--local]` → materializes the
catalog dir into `$XDG_CONFIG_HOME/opencode/plugins/bro/` or
`.opencode/plugins/bro/`. v1 plugin shapes (`server:`, `chat.*`
events) are dead upstream — the adapter is v2-only by contract.

## Requirements

- **R1** — v2 surface only: no v1 event names may reappear; the
  matrix's opencode row documents the v2 spellings.
- **R2** — RPC contract stability: `rpc.ts` is the single typed
  boundary — TUI and server change together or not at all; HTTP
  `POST /api/rpc/bro/<method>` stays reachable for external clients.
- **R3** — Stop stays reprompt-once via `stop_hook_active`; never
  wire a synthetic loop.
- **R4** — Tool namespace + `/bro`/`/act` commands + skill
  registration keep working from the catalog dir with no repo
  checkout assumptions (installed copies resolve the CLI via the
  standard ladder).
- **R5** — `tool.execute.before/after` keep `outcome:
  'synthesized'` (`isError`) — the host reports no success field.
- **R6** — `plugins/opencode/bro/` stays generated; sources live in
  `packages/agent-plugins/opencode/src/`.

## Verify

- `host-matrix.test.ts` opencode row green; `check:plugins` clean.
- `hooks.e2e.test.ts` + adapter unit tests (`packages/agent-plugins/
  opencode/src/*.test.ts`).
- Live (dogfooded during SDD work): `opencode run` sessions show
  rehydration context, board widget refresh, `bro_*` tools callable,
  `/bro` command output, attention toasts.
- RPC: `POST /api/rpc/bro/board` returns the board JSON from a live
  opencode server.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: v2 plugin surface, RPC
  channel, tool namespace, reprompt stop; v1 declared dead.
