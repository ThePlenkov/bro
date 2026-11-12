---
template: brotocol/spec@2
id: AGT-10
title: herdr — not an agent host: the multiplexer boundary case
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/herdr/
aliases:
  - herdr
---

# AGT-10 — herdr: not an agent host — the multiplexer boundary case

## Problem

herdr is a terminal multiplexer for coding agents — it *hosts* agent
sessions but is not one. `plugins/herdr/` is therefore the contract's
boundary case: bro's logic inside herdr is not session lifecycle
(no hooks, no prompts, no stops) but **supervision and mirroring** —
pane state, ACP session watching, bead claims, PR gates, worktree
events. The spec exists to state the boundary explicitly: AGT-1's
"X may be anything" includes hosts that are not agents, and the
contract's answer for them is a different plane entirely — the
fleet/observation plane, not the lifecycle plane.

## Design

### Surface: `herdr-plugin`, async — outside HOOK_MATRIX by design

`plugins/herdr/` is a herdr plugin (`herdr-plugin.toml` + `src/*.ts`
+ `tui/`), not a hooks adapter — it does not appear in `HOOK_MATRIX`
because it wires no `bro hooks` events. Its sources are first-class
TypeScript (not generated single-file artifacts): `reconcile.ts`,
`mirror-pane.ts`, `acp-watch.ts`, `live-views.ts`, `board.ts`,
`sessions.ts`, `lanes.ts`, `planes.ts`, `mirrors.ts`, `sources.ts`,
`statuses.ts`, `renderers.ts`, `sync.ts`, `lib.ts`, plus `action-*`
handlers (`claim-bead`, `pr-gate`, `acp-watch`, `open-worktree`,
`board`) and a TUI (`tui/main.ts`, `tui/acp/`).

### What bro does inside herdr (the supervision plane)

- **Pane mirroring** — agent panes render bro state (beads, PR
  gates, session status) inside herdr's own UI surfaces.
- **ACP session watch** — `acp-watch.ts` follows Agent Client
  Protocol sessions herdr hosts; fixtures (`test/fixtures/
  acp-session.jsonl`, `fake-acp-agent.ts`) pin the wire format.
- **Bead claims from panes** — `action-claim-bead.ts` lets a herdr
  pane claim work into the shared beads store — the state plane
  (AGT-1) reached through a non-agent UI.
- **PR gate actions** — `action-pr-gate.ts` surfaces review-gate
  state per pane/PR.
- **Worktree events** — `event-worktree-created.ts` keeps bro's
  worktree registry in sync with herdr-created trees.
- **Live views / board / lanes / planes** — the fleet observation
  surfaces rendered into herdr's TUI.

### The boundary rule

AGT-1's contract governs *agent sessions*: lifecycle events, context
injection, gates. herdr has no session lifecycle to hook — the agents
inside its panes carry their own bro plugins (AGT-2…AGT-9) and do
the gating themselves. herdr's plugin is the **observer**: it reads
the same state plane (beads, claims, PRs, worktrees) and renders it,
plus offers actions that write into that plane (claim a bead, open
a worktree). It never blocks an agent's stop — it isn't the agent.

This gives the contract its full topology:

```text
agent hosts (AGT-2..9): lifecycle plane — hooks, gates, context
herdr (AGT-10):         observation plane — mirror, watch, render
both:                   state plane — beads/claims/markers on disk
```

### Native functions leveraged

- **herdr plugin API** — `herdr-plugin.toml` manifest, action
  handlers, TUI slots, ACP session events — herdr's own extension
  surfaces, not a generic hook bus.
- **ACP** — the Agent Client Protocol is how herdr sees inside
  agent sessions; bro's watcher consumes the same stream rather than
  inventing a parallel one.
- **Shared state plane** — every action writes beads/markers the
  agent-side plugins already read; no herdr-private state silo.

## Requirements

- **R1** — herdr stays off `HOOK_MATRIX` — it is not an agent host;
  adding fake cells to claim coverage would corrupt the matrix's
  meaning. Its contract is this spec + the supervision plane.
- **R2** — Observation never gates: no herdr surface may block,
  delay, or rewrite an agent session's lifecycle — mirror/watch/
  render/actions only.
- **R3** — Actions write the shared state plane (beads claims,
  worktree registry) — never a herdr-private parallel store.
- **R4** — ACP watch consumes the protocol's wire format as
  fixtures pin it; format drift is a test failure, not a silent
  degradation.
- **R5** — `plugins/herdr/` is first-party source (not generated) —
  the one plugins/ dir that is hand-maintained; `check:plugins`
  exempts it by design.

## Verify

- `plugins/herdr/test/` suite green (sources, converge, status,
  acp-render, acp-watch against fixtures).
- Live: herdr session with agent panes shows bro board/status per
  pane, ACP watch tracks a live session, claim/pr-gate actions land
  in beads.
- Boundary proof: an agent pane inside herdr still gates itself via
  its own plugin (AGT-2…9) — herdr neither helps nor hinders the
  stop gate.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: multiplexer boundary case —
  supervision/observation plane, not lifecycle; keeps herdr honest
  as "X that is not an agent".
