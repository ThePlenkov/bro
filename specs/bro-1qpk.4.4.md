---
parent: bro-1qpk.4
---

# bro-1qpk.4.4 — TUI module: `/bro` keymap layer + gate toasts

## Problem

Nothing reaches the operator's eyes: gate decisions, fleet state, and
the live board are invisible inside the opencode TUI.

## Design

A second artifact `packages/cli/src/opencode-tui.ts` → materialized to
`plugins/opencode/bro/cli.ts`, a `@opencode/plugin/tui` entrypoint
(`Plugin.define({id:'bro.cli', setup})`) — the V2 terminal plugin
contract, structurally declared (no runtime import).

- `context.keymap.layer` — one `bro.status` command: palette + slash
  `/bro`, runs `bro status` and shows the board via
  `ui.toast.show` (long output → toast body).
- `context.data.on('session.idle')` / `('permission.asked')` — toast the
  gate state: idle after a blocked stop → warn toast with the blocker.
- CLI resolution ladder shared by copy with the server module —
  standalone artifact, node builtins only.
- install targets: `bro plugins install opencode` gains a second file —
  `~/.config/opencode/plugins/bro-cli.ts` and
  `.opencode/plugins/bro-cli.ts` beside `bro.ts`.
- `isBroAdapter` sentinel: `id:"bro.cli"` + `kind:"opencode-tui"`
  marker so install/uninstall recognize the file.

### Acceptance

- `cli.ts` exports `{id:'bro.cli', setup}`; setup registers the keymap
  layer and event taps, returns a disposer
- `plugins.ts` ships the second target for `opencode` installs
- `npm run gen:plugins` emits `plugins/opencode/bro/cli.ts` + README
  section; `check:plugins` drift-clean
