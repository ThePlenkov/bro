# bro-m8hew — herdr plugin sync pane does not survive host reboot

## Problem

The `bro sync` pane (`node src/sync.ts`) is the plugin's converge daemon — the
only thing that re-arms dead session/status panes. The manifest declares it
under `[[panes]]`, but herdr treats `[[panes]]` entries as templates
materialized only through `plugin.pane.open`; nothing re-opens them on server
start (verified in herdr source: `run_plugin_startup_hooks` covers `[[startup]]`
only, `plugin.pane.open` has no dedup). After a host reboot the server came back
with every session pane on a bare zsh and no loop to notice — workspaces stayed
labeled but dead.

## Change

`plugins/herdr/src/reconcile.ts` main-block gains `ensureSyncLoop()` before the
one-shot converge: `pgrep -f "node src/sync.ts"` is the liveness probe (a dead
pane's bare shell does not match), `herdr plugin pane open --plugin bro.fleet
--entrypoint sync` restores it when absent. Both the `[[startup]]` hook and the
manual `sync` action run this file directly, so both entry points self-heal.

## Verification

Live in the toolrun checkout: kill `node src/sync.ts` → run `reconcile.ts` → new
`bro sync` pane opened (pid 232990, w0:p28) and converged on its first pass;
with the loop alive the probe skips and no duplicate pane appears.

## Out of scope

- Mid-session crash supervision (a killed loop still needs one startup/action
  run to recover; a pane-lifetime watchdog would be herdr-side).
- Herdr auto-spawning `[[panes]]` at server start — a herdr feature request,
  not bro-side.
