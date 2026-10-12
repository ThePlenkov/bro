---
scope:
  - packages/cli/src/commands/daemon.ts
  - packages/cli/src/commands/drive-pulse.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/plugins.ts
  - skills/drive/SKILL.md
  - skills/daemon/SKILL.md
  - site/content/docs/commands/fleet.md
  - README.md
---

# bro-y5zon — `bro drive install`: the always-on merge path

## Problem

A green PR with a dead owner merges from: the loop gate (dies with the
loop), `act wait --merge` (dies with the session, rearmed only on a new
session), or `bro drive --every` — a manual opt-in that today survives
as a hand-rolled `/tmp` while-respawn wrapper (anti-dogfood). `bro
daemon up` gave the supervisor a lifecycle (`up`/`status`/`down`), but
nothing persists the *want*: a dead recorded daemon is an attention
line asking for a hand restart.

The bead predates bro-killn's ruling: OS service management is outside
the agent-plugin horizon — the systemd/crontab *writers* are retired.
bro-1x7p already anticipated this slice: "a `drive install`
generalization earns a spec when the marker machinery does." The marker
machinery shipped (`pulse.json` + session checkpoints); this is the
drive generalization — durable want-marker + session-owned rearm, not a
user timer.

## Design

`<git-common>/bro/drive.json` — the install want-marker `{everySec,
armedAt}`, the merge-path analogue of `pulse.json`. Durable: survives
reboots, session deaths, worktree churn.

```
bro drive install [--every N] [--print]   arm + bring up now (enable --now)
bro drive uninstall                       disarm + stop the supervisor
```

- `install` writes the marker, then brings the supervisor up through the
  same path `bro daemon up` runs (decide → `daemon.up.lock` → detached
  spawn → `daemon.json` record). A live supervisor — daemon or raw
  `bro drive --every` — reports `already`, never doubles. Refuses under
  `BRO_AGENT_ID` like every other supervisor-arming surface.
- `uninstall` removes the marker **first** (a racing checkpoint can
  never rearm a disarmed want), then runs the `daemon down` sweep —
  SIGTERM the holder/standbys, clear `daemon.json`.

### The rearm checkpoint

A new `driveConnector` contributes `sessionStart` + `postTool` probes —
the same lifecycle slots the watch pulse rearms on. It lives in its own
leaf module `drive-pulse.ts` (mirroring watch-pulse.ts): plugins.ts
registers connectors at module-eval time, so a connector const inside
the plugins↔commands import cycle would TDZ — the probe lazy-imports
the supervisor machinery:

1. `driveRearm` decides, pure: orchestrator + marker armed + supervisor
   dead → `rearm`. `daemonProbe` *is* the spawn record check —
   `daemon.json` plays the `pulse.spawn.json` role (a live recorded
   child suppresses, covering the pre-lock window and the standby case;
   a dead recorded pid does not — the next event retries).
2. The probe runs `supervisorUp` — the extracted decide→spawn→record
   sequence under `daemon.up.lock`, so a racing `daemon up`, a second
   session's checkpoint, or a double-fire collapses to `already`.
3. A spawned child is reported (`drive supervisor rearmed on … — pid
   N`); every failure stays silent — a probe must never break the hook
   event it rode in on.

### `daemon down` is transient under an install

`down` stops the supervisor but leaves the marker — the next checkpoint
re-arms it (systemd `stop` ≠ `disable`). The down report names this:
`installed — the next session checkpoint rearms it; 'bro drive
uninstall' disarms`. `daemon status` surfaces the armed state
(`· installed (every Ns)`), and `bro watch`'s daemon plane renders the
install: a dead armed supervisor reads as a checkpoint-rearm gap, not
a "restart it by hand" gap.

## Plan

1. `daemon.ts`: `driveMarkerPath`/`readDriveMarker`/`armDrive`/
   `disarmDrive` (tmp+rename, same malformed-as-absent rule as
   `pulse.json`); extract `supervisorUp`/`supervisorDown` from
   `daemonUp`/`daemonDown` (they become print wrappers); `driveRearm`
   (pure); `installDrive`/`uninstallDrive` (injectable up/down for
   tests); `daemon status` gains the armed note, `daemon down` the
   rearm hint. `drive-pulse.ts` (new leaf): `supervisorCheckpoint` +
   `driveConnector`.
2. `drive.ts`: `install|uninstall` verbs dispatched before `driveArgs`;
   `install` refuses under `BRO_AGENT_ID` and bounds `--every` by the
   shared interval floor; header + usage.
3. `watch.ts`: daemon plane gains `installed`; attention + render lines
   distinguish "installed but dead — checkpoint rearms" from the
   manual-restart message.
4. `plugins.ts`: `registerConnector(driveConnector)` beside
   `watchConnector`.
5. Tests (`daemon.test.ts`): marker path/round-trip/malformed reads,
   `driveRearm` matrix (worker guard, armed×live), `installDrive`
   (arm+up outcome ladder, `--print` purity, idempotent arm),
   `uninstallDrive` (disarm-then-down order, absent state).
6. Skills/docs: `drive` + `daemon` SKILL.md, `fleet.md` drive section,
   README row.

## Non-goals

- No OS scheduler entries — bro-killn retired them; the checkpoint is
  the rearm, same as the pulse.
- `daemon down`'s machine-wide `pgrep` sweep stays as-is; scoping it
  per-repo is separate work.
- Queue-empty self-termination of the daemon (bro-ybrja's deferred
  slice) — when it lands, a clean exit vs a crash is distinguishable
  state the rearm decision can read.

## Acceptance

- `bro drive install` on a quiet repo: `drive.json` written, supervisor
  spawned detached, `daemon.json` records it, `daemon status` shows
  installed.
- Installed + dead supervisor: the next sessionStart/postTool
  checkpoint respawns it (reported with pid); a live supervisor or a
  live recorded child stays quiet; `BRO_AGENT_ID` sessions are quiet
  always.
- `bro drive uninstall`: marker gone, supervisor signalled, record
  cleared; subsequent checkpoints stay quiet.
- `bro daemon down` under an install: supervisor stops, the hint names
  the rearm + the disarm path; the next checkpoint brings it back.
- `bro drive install --print` touches nothing.
