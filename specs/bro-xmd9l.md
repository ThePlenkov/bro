# bro-xmd9l — event-triggered re-projection for the herdr fleet projector

## Problem

The daemon-owned fleet projector (`projectFleet`, spec bro-u19mq;
native LED via `pane report-agent`, spec bro-awqde) runs only at the end
of each `driveOnce` pass — the `--every` cadence (300s in production).
Between passes, agent exits, respawns and silence transitions are
invisible to the LED: a crashed worker keeps its `●` working icon for
up to five minutes, and a `✓` exits marker arrives equally late.

## Decision

The daemon already carries an in-process event loop and the repo bus
already publishes every lifecycle transition it needs —
`worker.spawned`, `worker.exited`, `worker.silent` (spec bro-294hf's
journal mirror), and `worktree.added`/`removed`. `bro drive --every`
(the same process as `daemon run`) subscribes to that feed and kicks a
re-projection on every envelope.

Rules:

- **One writer, one surface.** Events schedule the same
  `herdrProjectorTick` the pass-end tick calls — the bus is a _hint_,
  never a second writer. The single-writer rule (daemon projector
  owns fleet labels + LEDs; session plugins own lifecycle only) is
  unchanged.
- **Coalesced, not per-event.** A burst of exits (an exit-harvest can
  emit several envelopes in one sweep) collapses into one pass: a
  pending kick swallows further events; a cooldown (~1.5s) bounds the
  extra write rate. Leading-edge when idle, cooldown-trailing under
  load — snappy steady state, bounded worst case.
- **Fail-open.** No broker, an unreachable socket, or a dropped
  subscription degrades to tick-only — the interval pass is always the
  floor. The subscription re-arms lazily at the next tick boundary, so
  a broker that comes up later restores event mode without a daemon
  restart.
- **No new process.** `busSubscribe` is an in-process socket held by
  the drive loop — unref'd, closed with the subscription, never a
  child spawn. `--once` passes never subscribe (they exit anyway).
- **Gap = re-project.** A `gap` frame (cursor fell out of the replay
  window, broker restarted) means events were missed — kick a full
  re-projection, since `projectFleet` re-derives everything anyway.
- The 300s tick keeps its two jobs: herdr-restart rehydration
  (self-reported authority is not persisted — every tick re-asserts)
  and the catch-all for transitions with no envelope (herdr-side pane
  death, ledger edits, clock buckets expiring mid-silence).

## Shape

```text
drive --every
  ├─ every N s: driveOnce → … → herdrProjectorTick   (backstop)
  └─ busSubscribe {topics:[worker,worktree]}
       onEvent/onGap → kickProjector ─coalesce─▶ herdrProjectorTick
       onClose       → sub=undefined → re-arm next tick
```

Kick semantics: `PROJECTOR_KICK_MS` cooldown; if a kick is already
scheduled, events are absorbed (the scheduled pass sees the latest
state anyway — projection is a full re-derive, not a delta).

## Out of scope

- Subscribing session plugins or renderers — the daemon is the only
  projector; plugins never write fleet labels or LEDs.
- Per-worktree deltas — `projectFleet` already dedups herdr writes
  against live label/token state; LED reports are idempotent
  heartbeats, so a full pass is cheap.
- New event kinds — the existing `worker.*`/`worktree.*` mirror
  covers spawn/exit/silence/add/remove; nothing else needs emitting
  for this consumer.
