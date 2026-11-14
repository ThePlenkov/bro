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
| stop | `event` → `session.execution.succeeded` | reprompt, context — `stop_hook_active` skip |
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

- Stop: no pre-stop slot → `session.execution.succeeded` (v2's
  completion event — `session.idle` is schema-declared but never
  published, opencode#55358) delivers the blocker as
  ONE synthesized prompt (`reprompt` via `session.prompt`/
  `synthetic`), later executions skipped via persisted `stop-gated`
  storage + `stop_hook_active`. `stopRefusal: 'reprompt'`.
  `execution.failed`/`.interrupted` never gate.
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
- **R4** — 8 `bro_*` tools keep pinned argv — reads only — and must
  reach the model as **direct function tools** (`codemode: false`);
  codemode-only exposure hides them from the tool catalog.
- **R5** — `/bro` quote-aware splitting preserved (`learn capture
  "a note"` must not shred).
- **R6** — Skills dedup: plugin-dir registration vs
  `~/.agents/skills/` never double-register.
- **R7** — `plugins/opencode/bro/` stays generated.

## Verify

- `host-matrix.test.ts` opencode row; adapter tests; `check:plugins`.
- `packages/agent-e2e` opencode e2e: real `opencode run` against an
  aimock provider — asserts journal traffic, mock reply in output,
  and ≥8 `bro_*` direct tools in the request's `tools` array.
  FakeBro scenarios: session-start context reaches the model request,
  stop gate blocks→reprompts→passes through `opencode serve`,
  pre-tool veto reaches the model as the tool result.
- Live (dogfooded in SDD work): `opencode run` sessions — hydration
  context, board widget, `bro_*` tools callable, `/bro` output,
  attention toasts; `POST /api/rpc/bro/board` returns board JSON.

- **Scenario map** (AGT-1 §Test scenarios): implemented e2e —
  S1 session-start ctx, S2 pre-tool veto, S3 stop gate (serve
  mode, v2 `session.execution.*` taxonomy) in
  `fakebro.e2e.test.ts` + `opencode.e2e.test.ts` (S-coverage:
  run-turn, ≥8 direct `bro_*` tools). S4 `/bro` dispatch verified
  e2e — `bro-command.e2e.test.ts` drives `POST
  /api/session/{id}/command` and asserts `bro <args>` argv in the
  FakeBro journal plus the follow-up turn on aimock. Declared
  applicable — S5 compaction rehydrate,
  S6 multi-turn, S7 fail-open, S9 skills dedup, S10 native
  correlation. S8 dep-degraded covered at the bro layer —
  `deps.e2e.test.ts` runs real `bro hooks post-tool` against a
  failing ScriptedCli `bd`: fail-open holds, dep journal records
  the `kv list` probe.

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
- 2026-11-13 — v4: e2e-caught conformance fix — `bro_*` tools were
  registered without `codemode: false`, so opencode exposed them only
  through the `execute` code-mode tool and the model-facing `tools`
  array carried zero `bro_*` entries. Tools now register with
  `codemode: false` → direct `bro_*` function tools; R4 hardened,
  Verify gains the agent-e2e journal assertion.
- 2026-11-13 — v5: e2e-caught lifecycle fix — the event-stream stop
  gate listened for v1 names (`session.idle`, `message.updated`,
  `session.created`, `session.compacted`) that opencode v2 never
  publishes; the gate was dead in production. Bus handling moved to
  the verified v2 taxonomy: `session.execution.started` primes
  rehydration, `.succeeded` marks the clean turn AND fires the gate,
  `.failed`/`.interrupted` disarm it; `session.compaction.*` re-primes
  post-compaction; `session.deleted` unchanged. `packages/agent-e2e`
  gains FakeBro (scripted `bro hooks` responder + journal) and the
  serve-mode driver; the stop-gate scenario now runs live against
  `opencode serve`.
- 2026-11-12 — v6: Verify gains the AGT-1 scenario map — S1/S2/S3 implemented e2e today; S8 pending ScriptedCli wiring.
- 2026-11-12 — v7: S8 lands at the bro layer — `deps.e2e.test.ts`
  proves real `bro hooks` stays fail-open against a dead `bd`
  shim and journals the dep probe.
- 2026-11-14 — v8: S4 `/bro` dispatch verified e2e — serve-mode
  `POST /api/session/{id}/command` leg of `bro-command.e2e.test.ts`
  asserts identical `bro <args>` argv in the FakeBro journal and the
  follow-up turn reaching aimock.
