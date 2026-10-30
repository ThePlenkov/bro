# bro-awqde — native LED via `pane report-agent` from the daemon projector

## Problem

The daemon projector (spec bro-u19mq, merged #797) writes the
`[state·#PR]` label prefix and the `status` metadata token — colored
text via sidebar token rules. The native herdr state indicator (the
per-pane LED: `●`/`×`/`✓`/`·` — Working yellow, Blocked red, Done teal,
Idle green, Unknown dim) still only reflects screen-detected agents:
detached fleet workers (loop runs, registry spawns, dead panes) never
light it. Spec bro-8dbyb ruled `pane report-agent` out because semantic
status on a live pane "adds nothing the label doesn't already carry" —
that predates the LED ask: the user wants the native icon, not more
text.

## Design

Extend `projectFleet` in `packages/cli/src/commands/herdr-projector.ts`
— same managed∩open workspace set, same per-worktree `TreeProjection`
the label/token already compute, one more write per workspace: drive
the native pane indicator via `herdr pane report-agent` /
`release-agent`. Ownership rule stands: only the daemon projector
reports fleet state; session plugins never do.

### The write path (verified against herdrdev/herdr source)

```bash
herdr pane report-agent <pane_id> --source bro-fleet --agent fleet \
    --state working|blocked|idle|unknown --seq <N> [--message TEXT]
herdr pane release-agent <pane_id> --source bro-fleet --agent fleet --seq <N>
```

- `report-agent` installs a `HookAuthority` that WINS arbitration over
  screen detection (`TerminalState::recompute_effective_state`) →
  renders the native indicator, emits `pane.agent_status_changed`,
  feeds `agent wait`, notifications, and the workspace aggregate
  (`Blocked>Done>Working>Idle>Unknown` by `status_priority`).
- Sources starting `herdr:` are reserved and degrade — use a custom
  `--source bro-fleet`.
- `--seq` must be monotonic per source (`hook_report_is_newer`) — the
  projector passes the pass instant `now` (unix millis); monotonic
  across ticks by construction.
- Authority is NOT persisted across herdr restarts → re-report every
  projector tick, fire-and-forget, failures ignored.
- An unrecognized `--agent` label is "self-reported": the pane loop
  (~1s probe) auto-clears the authority when the pane's shell sits at
  an idle prompt (`self_reported_agent_active` /
  `ReportedAgentShellReturned`). Reports only HOLD on panes with a live
  foreground process.
- A report is rejected when a DIFFERENT known agent is currently
  detected on the pane — only panes whose bound agent is ours or absent
  are candidates.

### State mapping (single source of truth — same classification as labels)

| `TreeProjection.state` | `report-agent`                                                      |
| ---------------------- | ------------------------------------------------------------------- |
| `working`              | `--state working`                                                   |
| `silent`               | `--state working --message silent<N>m/h`                            |
| `interrupted`, `lost`  | `--state blocked --message <state>`                                 |
| `exited`               | `--state idle --message exited` (native `done` ✓ on unviewed panes) |
| `stopped`              | `release-agent` (row disappears)                                    |
| absent, tree armed     | `--state unknown`                                                   |
| absent, tree unarmed   | `release-agent`                                                     |

### Pane selection

Candidates come from the plugin state ledger the projector already
reads for `managed` (`state-<scope>.json`): the worktree's `renderers`
record and its unmarked `mirrors` records (marked mirrors are dead
tails — idle shells that would self-clear). Mirrors first (the pane
tailing the actual worker), renderer tail second. The rec's recorded
`workspace` must equal the live workspace id — same ownership
discipline as `managed`.

A candidate is reported onto only when `pane list` shows it exists and
carries no foreign detected `agent`, AND `pane process-info` shows a
non-shell foreground process — the auto-clear probe makes a report on
an idle shell pointless (it would clear in ~1s). No suitable pane →
skip the LED for that workspace this tick; never report onto an idle
shell.

### Degradation

Every new call rides the existing `herdrRun`/`herdrOk` boundary (5s
timeout, fail-quiet): unreachable socket, missing pane, foreign-agent
rejection — all degrade to a skipped LED, never a thrown tick. LED
calls are not dedup'd (re-report every tick is the protocol) and are
counted separately from diff `writes` in `ProjectResult.leds` so
steady-state passes don't log as churn.

## Tests

- `ledReport` mapping matrix — every `WorkerState`, silent message,
  armed/unarmed no-state.
- `ledPane` selection — missing pane skipped, foreign `agent` skipped,
  first valid candidate wins, mirrors preferred over the renderer.
- `projectFleet` integration over the fake herdr — `pane list` /
  `process-info` / `report-agent` / `release-agent` argv asserted; idle
  foreground skips the report; no-ledger-candidates does no pane reads
  at all.
