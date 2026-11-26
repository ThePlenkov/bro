---
template: brotocol/spec@2
id: AGT-10
title: herdr — supervision plane, not an agent host (boundary case)
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/herdr/
aliases:
  - herdr
---

# AGT-10 — herdr: supervision plane, not an agent host (boundary case)

## Problem

herdr is a terminal multiplexer / session orchestrator — it hosts
*panes running agents*, it is not itself an agent. The contract's
boundary case: bro integrates at the **observation + orchestration
plane**, never the lifecycle plane. The spec pins what herdr gets
(pane mirror, ACP watch, board surfaces) and what it must never
claim (hook cells, stop gates, `/bro`).

## Design

### Surface: `plugin`, supervision-only — outside HOOK_MATRIX

`plugins/herdr/` = `herdr-plugin.toml` + `src/*.ts` + `tui/` —
a herdr plugin directory, not a hook manifest. herdr has no
agent-lifecycle events bro can hook; integration rides pane/ACP/
worktree observation instead. `HOOK_MATRIX` has no herdr row —
correctly: there are no cells to fill.

### What the plugin adds — the inventory

| asset | mechanism |
| ----- | --------- |
| pane mirror | watches herdr panes — detects which agent runs where, surfaces live session state on the board |
| ACP watch | observes Agent Client Protocol sessions — claims/status for ACP-driven agents |
| board surfaces | `live-views`, `lanes`, `planes` TUI sections — the multiplexer view of bro's fleet state |
| claim-bead / pr-gate / worktree events | worktree + PR state surfaces mirrored into herdr panes |
| `/bro` command | **none** — herdr has no agent-command slot; commands live inside the hosted agents' own plugins |
| `bro_*` tools | **none** — herdr is not a model host |
| skills | n/a — skills belong to the hosted agents, not the multiplexer |
| lifecycle hooks | **none by design** — the agents inside panes carry their own hooks; herdr would double-fire |

### The boundary rule

An agent running *inside* a herdr pane brings its own plugin
(AGT-2…9) — its hooks, `/bro`, tools fire normally. herdr's plugin
only *observes and orchestrates* across panes: which session owns
which bead, where worktrees live, PR gate state. Two planes, never
merged: **lifecycle belongs to the hosted agent; supervision
belongs to herdr.**

### Native correlation

herdr's native pane/tab/workspace/session commands stay native.
bro adds observation surfaces (board views, ACP watch) — never a
competing session manager. `bro-herdr` skill + `bro-herdr` CLI
surface document the operator workflow.

## Requirements

- **R1** — No `HOOK_MATRIX` row, no hook cells — supervision only.
- **R2** — Never double-fire: agents inside panes keep their own
  plugins; herdr must not inject a second lifecycle.
- **R3** — Observation surfaces stay read-mostly — pane mirror,
  ACP watch, board views; orchestration actions go through the
  hosted agent's own surface or `bro fleet`, not pane-level hacks.
- **R4** — `plugins/herdr/` layout stays `herdr-plugin.toml` +
  `src/` + `tui/` per herdr's plugin spec.
- **R5** — ACP watch declares its protocol coverage honestly —
  unobservable agent kinds are named, not silently skipped.

## Verify

- `bro-herdr` skill paths exercised; pane mirror reflects a live
  opencode/claude session; board views render fleet state.
- Negative: no bro hook events fire from herdr itself; hosted
  agent's own plugin unaffected.

- **Scenario map** (AGT-1 §Test scenarios): not applicable —
  herdr is the supervision plane, outside HOOK_MATRIX by design;
  no hook events, no `/bro`, no `bro_*` tools. Conformance is
  herdr-specific: pane mirror, ACP watch, board surfaces —
  verified by observation checks, never S-IDs.

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: asset inventory reframed as
  supervision-plane (pane mirror, ACP watch, board surfaces),
  lifecycle-boundary rule made explicit.
- 2026-11-12 — v3: Verify declares the S-catalog not-applicable — supervision plane conformance is observation-based.
