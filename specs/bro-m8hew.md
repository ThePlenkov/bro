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
one-shot converge, and `sync.ts` publishes `process.pid` to
`<STATE_DIR>/sync-<scope>.pid` at startup (`syncPidPath` in `lib.ts`, scoped
like the state file). The probe is pid liveness on a number the loop wrote
itself — never argv matching, which a non-node or absolute-path launcher
would slip (review: the first draft's literal `pgrep` pattern failed exactly
this way). Both the `[[startup]]` hook and the manual `sync` action run this
file directly, so both entry points self-heal.

## Verification

Live in the toolrun checkout: kill `node src/sync.ts` → run `reconcile.ts` → new
`bro sync` pane opened and converged on its first pass; a second run with the
loop alive skipped the open (no duplicate). The pid file lands in
`HERDR_PLUGIN_STATE_DIR` — the same env contract every plugin command gets.

## Out of scope

- Mid-session crash supervision (a killed loop still needs one startup/action
  run to recover; a pane-lifetime watchdog would be herdr-side).
- Herdr auto-spawning `[[panes]]` at server start — a herdr feature request,
  not bro-side.
