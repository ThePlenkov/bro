---

drill: 2026-11-03-215500-a2dgm-status-panes-dead
parent: root
sha: a2dgm
scope: "why no bro:status panes are armed (statuses map empty) + opencode orchestrator health"
started: 2026-11-03T21:55:00Z
---

# Drill: status panes dead + orchestrator health

## Narrowed question

Projector fix (bro-a2dgm) restored the fleet write surface
(15/15 managed workspaces get labels, tokens, fleet-state files).
But `pane list` shows **zero `bro: status` panes** and the merged
ledger's `statuses` map is empty — `leds: 0`, nothing to push to.

Two parts:
1. Why does the plugin never record status-pane bindings — did the
   reconcile arm ever run, and what gate keeps it off?
2. Is the opencode orchestrator (fleet agent spawns on the ACP lane)
   actually running sessions — or is it itself broken, which would
   explain missing panes?

## Known state

- ledger `~/.config/bro-herdr-plugin/state-31af70c85d2e.json`:
  workspaces 42 (32 managed), sessions 24, **statuses 0**
- `herdr pane list`: 15× `bro: session`, 8 unlabeled, 1× `bro board`,
  0× `bro: status`
- workspaces carry herdr-native agent_status: working/idle/blocked

## Findings

### Q1 — status panes absent: NOT A BUG

`plugins/herdr/src/reconcile.ts:convergeStatuses` — an armed
`bro: session` pane folds the status strip into itself (spec
bro-l8wqu) and `retireStatus` removes the `bro: status` pane by
design. 15 session panes = 15 folded status strips. `statuses: 0`
and `leds: 0` are correct steady state on the acp lane.

### Q2 — orchestrator: REAL BUG, config-side (fixed)

Workers spawned by `fleet.routing.default` died `cause=auth`, exit 1.
Chain: `routing.default.chain=[{provider:"opencode-iceman"}]` carries
no `model`; `providers.opencode-iceman` had no `model` either →
`resolveWorkerSurface` leaves model undefined → `acp-worker` spawns
`opencode acp` unpinned → session runs the agent default
`vercel/zai/glm-5.3-flashx-legal` → the Vercel account is FREE TIER
and the model is paid-only → `Authentication required` → worker dies.
Proof: manual `acp-worker --command 'opencode acp' --model
opencode-go/iceman-contributor-free` → session pins the model and
completes `end_turn`. Without `--model` it dies exactly like the
fleet workers.

Fix applied (`bro.config.local.json`):
- `providers.opencode-iceman.model = opencode-go/iceman-contributor-free`
  (pins on every spawn path: routing, profile, direct)
- `agents.native.command` + `loop.agent`: `--model` was embedded in
  the INNER `opencode acp` command — this opencode build rejects it
  (`Unrecognized flag`) → any template-path spawn died instantly.
  Moved `--model` to the acp-worker flag position.
- `agents.native.provider = opencode-iceman` so non-routed native
  spawns render through the provider argv path, not the template.

### Latent bug found along the way — pid recycling

`bro-l8c4f.11` registered as alive: its recorded pid belongs to an
unrelated `gitstatusd` process — the registry's `/proc/{pid}`
liveness check gives a false positive on pid reuse.

## Prevention plan

- [immediate] config fix applied in bro.config.local.json (owner: drill)
- [bead] registry liveness should verify process identity (cmdline/
  start-time), not /proc existence (owner: parent)
- [bead] routed spawn with no resolvable model should warn at spawn
  time — an unpinned session silently rides the agent default
  (owner: parent)
- [note] session panes correctly show terminal archives of dead
  workers — when the fleet drains to zero workers there is nothing
  left to update; fix the spawn health, not the panes
