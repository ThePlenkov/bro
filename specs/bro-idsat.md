# bro-idsat — per-worktree status pane: bro-owned renderer self-reports the fleet LED

## Problem

The bro-awqde LED (spec) asserts `pane report-agent` on whichever
ledger pane survives probing — a heartbeat re-pushed every pass onto a
pane whose foreground belongs to somebody else (a mirror tail, a user
shell, the events renderer). That design has real costs: the daemon
pays a `pane list` + up-to-3 `process-info` probes per workspace per
pass, the assertion vanishes the moment the probed pane idles
(`self_reported_agent_active` clears on shell return), selection can
move between worker panes, and stale `bro-fleet` bindings have to be
hunted down and released every pass.

Operator design ruling (deep-research): the LED lives on a pane that
_is_ the reporter — one dedicated status pane per managed worktree
workspace, running a bro-owned foreground process.

## Decision

**Status pane.** Each plugin-managed worktree workspace gets exactly
one `bro: status` pane — a normal down-split (target keeps ~85%)
running `bro herdr status-view <worktree>` in the worktree cwd. The
plugin spawns/re-arms/adopts it in `convergeStatuses`, the same
record→orphan→split convergence `renderers.ts` uses; plugin state
gains a `statuses[path]` record `{workspace, worktree, pane_id}`.

**The pane process is the primary reporter.** `status-view`:

- no-ops outside Herdr (`HERDR_ENV`/`HERDR_PANE_ID`/`HERDR_BIN_PATH`
  unset — the add-herdr-support contract).
- reports `unknown` at startup to bind `bro:fleet`/`bro-status`, then
  reads the worktree's fleet-state file, renders the view, and
  self-reports the semantic state on its own `$HERDR_PANE_ID`:
  `pane report-agent <pane> --source bro:fleet --agent bro-status
  --state <idle|working|blocked|unknown> --seq <unix-micros>
  [--message …]`.
- carries display text through `pane report-metadata` on itself —
  `--display-agent <slug|fleet>` and `--state-label <state>=<status
  string>` — never claiming a builtin agent label. LEDs come ONLY from
  the semantic state; waits/notifications/rollups read it natively.
- watches `<git-common>/bro/fleet-status/<file>` (dir `fs.watch` —
  atomic rename swaps inodes — plus a 30s safety re-read) and
  re-renders + re-reports on content change only.
- while it occupies the pane foreground, authority holds — no
  heartbeat. On SIGINT/SIGTERM/SIGHUP it sends `release-agent` and
  exits; a bare crash leaves herdr's ~1s idle-shell probe to clear the
  binding (the documented safety net).

**The daemon stays the classifier.** `projectFleet` replaces the
worker-pane LED path with:

1. **state file** — `<git-common>/bro/fleet-status/<safe-basename>.<sha12(realpath)>.json`,
   atomic tmp+rename, written only when the JSON changed (dedupe keeps
   fs.watch quiet). Carries `{v, worktree, workspace, title, slug,
   status, led:{state,message?}, ts}` where `led` is the pane's
   semantic verdict.
2. **backstop push** — when the plugin ledger records a `statuses`
   pane for the workspace AND `pane list` still shows it unbound or
   bound to `bro-status`/`bro:fleet` (never a foreign agent), the pass
   pushes the same `report-agent` + seq itself. This covers the gap
   while a crashed status-view awaits re-arm. Primary stays the pane.

Semantic mapping (status file AND backstop share it — one function):

| classifier           | semantic  | message            |
| -------------------- | --------- | ------------------ |
| `working`            | `working` | —                  |
| `silent`             | `working` | `silent45m` bucket |
| `interrupted`/`lost` | `blocked` | the word           |
| `exited`             | `idle`    | `exited`           |
| `stopped`            | `idle`    | `stopped`          |
| armed, no worker     | `unknown` | —                  |
| unarmed, no worker   | `idle`    | —                  |

`stopped` is `idle`, not release: the status pane is a dashboard, not
the worker — it keeps its binding and shows the verdict. Release is
reserved for the pane's own exit.

`--seq` is unix-micros monotonic per process (`max(now·1e3, last+1)`
clamp) — nanos would overflow: `now·1e6` already exceeds 2^53, where
the `last+1` clamp silently collapses onto `last`. The pane process is
the steady-state writer, the daemon's pushes are fresher-than-file by
construction.

`source=bro:fleet`, `--agent bro-status` — an unrecognized agent label
by design (the Agent enum is hardcoded; self-reported integrations
carry their own names). Never `herdr:`-prefixed, never a builtin name.

**Removed:** ledger pane candidates (`PluginLedger.panes`), `ledPane`,
`paneBusy` probing, `LED_PROBE_MAX`, `ledPanes` stale tracking,
per-pass release sweeps. `ledReport`'s `release` kind disappears —
status-file `led` is always a report.

## Snappiness

The state file is the latency path: a worker exit emits a `worker.*`
bus envelope → the drive loop's event kick (spec bro-xmd9l) re-projects
within ~1.5s → the file flips → the pane's `fs.watch` fires → render +
self-report. The 300s tick remains the backstop and the herdr-restart
rehydrator (the pane's own startup report also re-binds instantly).

## Out of scope

- The `bro: events` tail stays — a raw event stream is a different
  surface than the status view.
- Session plugins subscribe/report nothing; the single-writer rule is
  unchanged (daemon classifies, the pane process reports for itself).
- Mirrors keep their worker panes — mirrors are not LED carriers.
