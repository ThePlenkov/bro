# bro-9me97 — herdr projector: fs.watch kick on write points the bus does not cover

## Why

`bro-xmd9l` armed event-triggered re-projection: the daemon subscribes
to the bus for `worker`/`worktree` envelopes and kicks `projectFleet`
through a 1.5s coalescing kicker. That covers events that emit a
lifecycle journal row — but three write points have no envelope:

- a `.exit` file lands the moment a worker dies (the spawn wrapper
  writes it), yet `agent-exit` only journals at the next harvest —
  which rides the 300s supervision pass
- `agents.json` mutates outside lifecycle emits (registry patches that
  are not spawn/exit transitions)
- plugin ledgers (`state*.json` in `~/.config/bro-herdr-plugin`,
  `$HERDR_PLUGIN_STATE_DIR`, `$XDG_STATE_HOME/herdr/plugins/bro.fleet`)
  have no bus path at all — a workspace binding change waits a full
  tick

## Fix

`armProjectorWatches(ctx)` arms filename-filtered `fs.watch`es next to
the bus subscription, once per daemon, loop mode only:

- `{common}/bro/` → `agents.json`
- `{common}/bro/agents/` → `*.exit` (death before the harvest)
- each `pluginLedgerDirs()` dir → `state*` (workspace + status-pane
  bindings)

All kicks funnel into the existing `projectorKicker` — a write burst
still lands ONE pass. The 300s tick stays as the safety net for
missed/overflowed inotify events. `pluginLedgerDirs()` is exported
from `@broject/herdr-kit` so the watch and the merge can never
disagree about where ledgers live.

Arming is per-slot and retried every tick — `bro/agents` only exists
after the first native spawn and ledger roots after the first plugin
run, so a dir absent at arm time re-attaches on a later pass rather
than staying tick-bound forever (same lazy re-arm shape as
`armProjectorEvents`). The kick closure rides the latest `Ctx`, so a
standby takeover re-binds kicks to the live daemon invocation.

## Contract

- A `.exit` appearance re-projects within the kicker window — a dead
  worker's label stops waiting for the harvest pass.
- A ledger write re-projects the same way — plugin-side binding changes
  stop being tick-bound.
- A dir absent at arm time is retried every tick until it appears; a
  watcher error or close drops the slot for re-arm on the next pass —
  never a crash inside the supervisor loop.
- `--once` mode arms nothing — a one-off pass is a report, not
  supervision.

## Verify

- `tsx --test packages/cli/src/commands/drive.test.ts` —
  `projectorWatcher` coverage: write a matching name → kick fires,
  a non-matching name stays quiet, an absent dir returns no watcher.
- Live: `bro fleet daemon up`, kill a native worker, watch
  `<git-common>/bro/daemon.log` — the projection lands within seconds,
  not at the next pass.
