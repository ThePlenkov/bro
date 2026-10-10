---
scope:
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/commands/watch-install.ts
  - packages/cli/src/commands/watch-pulse.ts
  - packages/cli/src/commands/watch-config.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/plugins.ts
  - skills/watch/SKILL.md
  - skills/drive/SKILL.md
  - README.md
  - site/content/docs/commands/fleet.md
---

# bro-killn — supervision inside the plugin horizon: session-pulse + hook rearm

## Problem

`bro watch install` (spec bro-7xgk.5) put the heartbeat on a non-agent
timer — a systemd `--user` unit, crontab fallback. That is OS service
management, outside the agent-plugin horizon: bro's world is sessions,
hooks, the mailbox, and bounded commands. The timer also survives nothing
that matters — durable state (claims, worktrees, the agent registry, the
mailbox) already survives reboots; only the *cadence* needed a home, and
the session is it. Retro: a `while true` respawn wrapper in /tmp did the
same job worse — ad-hoc orchestration is anti-dogfood.

Meanwhile the PR-side already has the right shape: `bro act wait` drops a
pid marker, the session-start hook flags a dead marker, `bro act rearm`
resurrects it. The watch cadence deserves the same marker + rearm
mechanics, not an OS scheduler.

## Design

The **orchestrator session** owns the cadence:

```
bro watch --every N --for S --notify   bounded window — the pulse
   ↓ window ends (exit is the event the session waits on)
bro drive                              one single pass — no --every
digest → re-arm the next window
```

### The two files under `<git-common>/bro/`

- **`pulse.json` — the want marker** (the "session-side rearm marker"
  the bead names). `bro watch install` writes it — `{everySec,
  armedAt}` — replacing the systemd/crontab writers entirely. Durable:
  survives reboots, session deaths, worktree churn.
- **`pulse.lock` — the liveness hold.** `bro watch --every` takes it
  via `awaitFileLock` (spec bro-2duu9 — heartbeated singleton hold, a
  duplicate stands by behind the incumbent). Live pulse = lock holder
  pid alive. `--once` holds nothing — a snapshot is a read.

### The rearm nudge

A new `watchConnector` contributes a `sessionStart` line: marker armed
+ no live pulse →

```
watch pulse armed (every Ns) but not live — rearm:
`bro watch --every N --for S --notify`; on window end run one
`bro drive` pass, digest, re-arm (session-pulse model, bro-killn)
```

`sessionStartProbe` already fires on SessionStart, PostCompaction and
the Cursor first-prompt hydrate path — all the rehydrate events get the
nudge free.

**GUARD — orchestrator only.** The connector emits the nudge only when
`BRO_AGENT_ID` is unset — the same predicate as the `orchestrator`
mailbox address in core/notify.ts. A spawned worker session never sees
it, so workers never recurse watchers. The teeth: `bro watch --every`
and `bro drive --every` *refuse* under `BRO_AGENT_ID` (exit 2) — a
worker cannot arm the cadence even by hand. `--once` stays legal for
everyone (a read).

### `bro watch install|uninstall` repurposed

- `install [--every N] [--print]` — strips any legacy systemd/cron
  entry for this repo (the migration path: timers already on machines
  must not double-tick beside the pulse), then writes `pulse.json`.
  Prints the armed cadence and points at the session-pulse model —
  nothing is written outside the git dir. `--print` shows the marker
  payload + the rearm command without touching anything.
- `uninstall` — strips the legacy entry (unchanged) and deletes
  `pulse.json`. A live pulse keeps its lock until it exits; the report
  says so.

The systemd service/timer and cron-line *writers* (`systemdService`,
`systemdTimer`, `cronLine`, `printArtifacts`, the install paths) are
deleted. The *readers/removers* stay: `detectBackend`, `unitName`,
`cronTag`, `readCrontab`, `stripCronTag`, `retireSystemdUnits` power the
legacy strip both install and uninstall share.

### Config

`watch.pulseSec` (new, default 900 — 15 min): the window bound the
nudge suggests. `watch.intervalSec` stays the tick cadence recorded
into `pulse.json` when `--every` isn't passed.

## Plan

1. `watch-pulse.ts` (new): `pulseMarkerPath`/`pulseLockPath`,
   `readPulseMarker`, `armPulse`/`disarmPulse` (tmp+rename), `pulseLive`
   (lock holder pid alive), `isOrchestratorSession` (`BRO_AGENT_ID`
   unset/empty), `pulseNudge` (armed && !live && orchestrator → line).
2. `watch-config.ts`: `pulseSec` (≥ interval bounds, default 900).
3. `watch-install.ts`: delete the writers; `installWatch` = legacy
   strip + `armPulse`; `uninstallWatch` = legacy strip + `disarmPulse`;
   `--print` emits marker + rearm command.
4. `watch.ts`: `--every` → `awaitFileLock(pulse.lock)` with standby
   report + `BRO_AGENT_ID` refusal; `watchConnector` registered in
   plugins.ts; header comment + `runWatchSched` rewired.
5. `drive.ts`: `--every` refuses under `BRO_AGENT_ID`.
6. Tests: `watch-pulse.test.ts` (marker round-trip, liveness, guard
   predicate, nudge conditions); `watch-install.test.ts` rewritten
   (marker write, legacy strip on install, idempotency, --print purity,
   uninstall marker+legacy removal).
7. Skills/docs: `watch` + `drive` SKILL.md carry the session-pulse
   policy (holder bullet stays — mailbox is still pull-based); README +
   site fleet.md rows.
8. `npm run gen:plugins`, `npm run build`, `npm test`.

### The checkpoint probes (slice 2)

Every lifecycle event is one checkpoint — `pulseCheckpoint` behind both
`watchConnector.sessionStart` (the first event, cold start) and
`watchConnector.postTool` (the warm path, every tool call):

1. `pulseRearm(dir)` decides, pure: armed marker + dead `pulse.lock`
   holder + orchestrator + no live recorded spawn → `rearm`.
2. The probe spawns the bounded window detached + unref'd (zero-cost —
   shell, no LLM; the hook exits on its own timeout) and records the
   child in `pulse.spawn.json`.
3. A live recorded spawn suppresses the next rearm — it is either the
   pulse itself or a standby waiting behind another contender; without
   the record every tool call would pile another standby on a dead
   incumbent. A dead recorded pid does not suppress — the next event
   retries.

Matcher note: the shipped Devin hook map keeps PostToolUse at `^exec$` —
every tool call would pay a `bro hooks` process for coverage the pulse
does not need; exec dominates agent activity, and the next exec call
checkpoints anything that happened between (bounded staleness, probes
are idempotent).

Delivery to the session is unchanged: mailbox drops drain on the same
postTool probe (the notify connector) and on Stop/UserPromptSubmit. A
fully idle session has no events — the bounded window simply dies and
the next event rearms it; orchestration never depends on the session
being awake.

- `BRO_AGENT_ID` guards the rearm on the write side too — a worker's
  postTool probe returns quiet always.
- Spawn uses `process.argv[1]` as the CLI entry so dist/npx/source
  installs all re-spawn themselves; the child takes `pulse.lock` under
  the same `--every` guard (workers exit 2 even if spawned by hand).

## Acceptance

- `bro watch install` on a repo with a legacy timer: timer gone,
  `pulse.json` written, nothing under `~/.config/systemd` or crontab.
- An armed repo with a dead pulse gets the bounded window spawned on
  the first checkpoint (session start or the next tool call) — the hook
  reports the pid; a live pulse or a live recorded spawn stays quiet;
  under `BRO_AGENT_ID` every checkpoint is quiet.
- `BRO_AGENT_ID=x bro watch --every` and `... drive --every` exit 2.
- Two `bro watch --every` on one repo: the second stands by and takes
  over when the first exits — never concurrent.
- `bro watch uninstall` removes the marker and any legacy entry, and
  reports a still-live pulse rather than claiming the cadence stopped.
