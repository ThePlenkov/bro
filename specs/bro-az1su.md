# bro-az1su — Interactive bro board overlay in omp TUI

## Problem

The omp plugin paints the bro board through `ctx.ui.setWidget` as a plain
string array (`boardLines` in `packages/cli/src/adapter/core.ts`): one
summary line, three beads, two fleet agents, hard-capped at 10 lines by
omp's widget renderer. It is passive — no navigation, no expansion, no
refresh — while `bro status --json` carries far more than the widget can
show (`beads.ready`, `loop.runs`, `worktrees`, `drill`, `watch.attention`,
per-agent `cause`/`worktree`/`provider`).

The user wants the board they already watch to be interactive: focus,
collapsible sections, their own keyboard.

omp's contract for this is `ui.custom(...)` — see
[docs/tui.md](https://github.com/can1357/oh-my-pi/blob/main/docs/tui.md)
(“TUI integration for extensions and custom tools”): a `Component`
(`render(width): readonly string[]`, `handleInput(data)`) mounted with
keyboard focus in editor area or overlay, resolved by `done(result)`.

## Design

**One new module, `packages/cli/src/adapter/board-panel.ts`, self-contained
per the adapter bundle rule** (the bundle may import node builtins only —
no runtime imports from `@oh-my-pi/pi-tui`; the `Component` contract is
structural).

- Sections built from `BoardStatus`: summary header, in-progress beads,
  ready (top N + total), fleet agents, loop runs, worktrees, drill frame,
  attention count. Each section is a collapsible element (the collapsed
  set is component state; all sections start expanded).
- Cursor over every visible line; the rendered line carries a `›` marker
  under the cursor.
- Keys: `↑`/`↓` and `j`/`k` move; `←`/`→` collapse/expand the section under
  the cursor; `Enter`/`Space` toggle it; `r` re-probes `bro status --json`
  through the driver (async, “refreshing…” state while in flight); `q`/
  `Esc`/`app.interrupt` (via the host `KeybindingsManager`) calls
  `done(undefined)` and closes. Footer line documents the keys.
- Render contract from docs/tui.md: return the **same array reference**
  while nothing changed (cache keyed by width + dirty flag); clip every
  line with `clip()` from `core.ts`; theme colors applied only after
  clipping (ANSI-safe), header accent / footer muted.
- `BoardStatus` in `core.ts` gains the structural fields the panel reads
  (`worktrees`, `beads.ready`, `loop.runs`, `watch.attention`, …) — the
  JSON already flows through; only the typed window widens.

**Wiring stays in the shared driver** (`host.ts`), one implementation for
omp and pi:

- `BroContext.ui` gains an optional `custom` (structural — hosts without
  it are unaffected).
- `BroDriver` gains `refresh(ctx)` — the same `statusJson` + `paint` path
  `turnEnd` already uses, exposed so the panel can re-probe.
- Bare `/bro` opens the overlay (`{ overlay: true }`, bottom-center over
  the transcript, editor untouched) when `ctx.hasUI`, the mode paints
  (`mode === 'tui'`), and `ui.custom` exists; otherwise the current
  behavior (run `status --json` + notify) stands unchanged. No new
  completion entry — `board` is not a CLI verb, and the drift test pins
  that table to the plugin registry.

## Plan

- [x] Widen `BoardStatus` with the fields the panel renders
- [x] `board-panel.ts`: section model, cursor, collapse set, key map,
      refresh state, cached render
- [x] `board-panel.test.ts`: navigation, section collapse/expand, refresh
      flow (fake async), close → `done`, width-cache reference stability
- [x] `host.ts`: `ui.custom` typing, `mountPanel` in the binding, bare `/bro` →
      overlay with headless/no-custom fallback
- [x] `npm run gen:plugins` (bundle refresh) + `check:plugins`, then
      `npm run typecheck` + `npm test` (CI-equivalent, no piped exit codes)
- [x] Smoke in the real omp TUI against the locally built plugin: open
      `/bro`, navigate, collapse, refresh, close
- [x] Docs: command description, plugin README mention of the panel
