---
parent: bro-1qpk.4
---

# bro-tm5zx — opencode V2 TUI plugin: sidebar board widget

## Problem

opencode v2 discovers TUI plugins only as **directories** under
`plugins/` whose `tui` entrypoint exports `Plugin.define({id, setup})`.
bro's V1 single-file `bro-cli.ts` is indexed by the server inventory
but never receives the TUI context — `/bro`, the gate toasts, and any
UI surface are dead code on v2. The v2 slot tree (`sidebar.content`,
`sidebar.footer`, `session.panel`, …) is the only way a plugin renders
into the sidebar; a bro board — what's in work, backlog top, fleet
load — belongs there.

## Design

A third artifact `packages/cli/src/opencode-tui-v2.tsx` → materialized
to `plugins/opencode/bro/tui.tsx`, installed as a **plugin directory**
`plugins/bro/tui.tsx` (global: `~/.config/opencode/plugins/bro/`,
local: `<repo>/.opencode/plugins/bro/`). The host supplies
`@opencode/plugin`, `solid-js`, and `@opentui/*` at runtime — real
imports, dev-only typings.

`Plugin.define({ id: 'bro.cli', setup })` — the V2 form of the same
TUI face, superset of the V1 `cli.ts`:

- `context.ui.slot({ append: 'sidebar.content' })` — the bro board:
  in-progress beads, top ready beads + readyTotal, live fleet
  (running/maxConcurrent), watch heartbeat age, dirty count. Polls
  `bro status --json` on an interval plus `session.idle`; hidden
  entirely when the cwd isn't a bro rig (fail-quiet).
- `context.keymap.layer` — `bro.status` palette + `/bro` slash command
  (same args → `bro <args>` → toast), ported from the V1 module.
- `context.data.on('permission.asked' | 'session.error')` — the gate
  toasts, same semantics as V1.
- The CLI resolution ladder and `exec` helper are copied per the
  standalone-artifact contract (verbatim materialization forbids
  shared imports).

## Non-goals

- No server-plugin changes: `bro.ts` keeps shipping as a single file
  (`plugins/bro.ts` and `plugins/bro/` coexist — the dir has no
  `server`/`index` entry, so the server inventory skips it).
- `bro-cli.ts` keeps installing for V1-era hosts; v2 ignores it.

## Acceptance

- `plugins/bro/tui.tsx` appears in `opencode plugin list` as a local
  TUI target after `bro plugins install opencode --global`.
- The sidebar shows the board in a bro rig and stays silent outside.
- `npm run gen:plugins` emits `plugins/opencode/bro/tui.tsx`;
  `check:plugins` drift-clean; `npm test` green incl. a stub-context
  test exercising slot registration and the poll→render data path.
