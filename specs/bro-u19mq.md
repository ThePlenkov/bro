# bro-u19mq — daemon-owned fleet status projector

## Problem

Fleet status labels on herdr workspaces are written by per-session plugin
sync loops (`plugins/herdr/src/reconcile.ts` + `status.ts`). Three live
failures:

- **Stale labels.** When a session dies its sync loop dies with it —
  crashed loop runs keep their last label (`[working]` on dead pids).
- **Detached workers read as nothing.** Loop/ACP fleet workers have no
  live pane bound to the workspace, so `agent_status` stays `unknown`
  and the label is the only signal — and it lies.
- **N sessions = N writers.** Every session's plugin races the same
  labels through `workspace rename` / `report-metadata`.

## Design

ONE writer: a **projector inside the bro daemon tick** (`driveOnce` in
`drive.ts`, which `bro daemon run` drives at `--every` cadence) computes
per-worktree state and pushes it to herdr over the CLI surface. Session
plugins keep only lifecycle work — `worktree open`, mirrors, renderers,
the reaper — and stop writing fleet labels/tokens. The input read sits
behind a function boundary so a future NATS subscription can feed the
same projection unchanged.

Supersedes the label/token half of spec bro-8dbyb; the plugin keeps its
other v2 mechanics.

### Ownership split

| Surface                                    | Owner            |
| ------------------------------------------ | ---------------- |
| `worktree open` + initial plain label      | herdr plugin     |
| workspace `managed` record (plugin state)  | herdr plugin     |
| mirror / renderer panes, workspace reaper  | herdr plugin     |
| `[state·#PR]` label prefix, `status` token | daemon projector |

The plugin never renames or writes metadata tokens after open; the
projector never opens workspaces. A workspace's "bro-owned" flag stays
the plugin's `managed` record — the projector reads the plugin state
file (`$HERDR_PLUGIN_STATE_DIR` or `~/.config/bro-herdr-plugin/
state-<sha1(git-common-dir).slice(0,12)>.json`) and only touches
workspaces where `managed === true` and the recorded ws id still equals
the live `open_workspace_id`.

### Projection (per worktree)

Computed from `<git-common>/bro/agents.json` (pid live, `state`,
`cause`, `stopped`, `exitStatus`), `<git-common>/bro/loop/*.json` run
records (silence via log/record mtime), live `.work` marker details,
worktree claim markers, the act-state cache, and in-progress beads —
all local reads, no network.

Worker token (first match wins — a live run anywhere beats dead
records):

- `working` — live loop run or live registry agent (`running|spawned`),
  output inside the stall window
- `silent<N>` — live run/agent, no output for N (bucketed: 5m under an
  hour, hourly above — `silent45m`, `silent16h`)
- `exited` — registry `cause: ok` / `exitStatus` recorded
- `interrupted` — `cause: rate_limited|quota` (agentEntryBlocked —
  resume candidate)
- `lost` — pid gone with no `.exit` record, or a dead loop-run record
- `stopped` — `stopped: true`
- absent — marker/claim-armed tree with no worker

PR layer (orthogonal): `·#<N> <frag>` when a PR resolves (bead link or
act-state `headRef` match within the 30-min label window), `·no PR`
when the tree is armed/has state but none resolves, absent otherwise.
`frag` is a compact gate summary, not the exit gate: `merged`/`closed`/
`draft`, then counts joined `/` — `<openThreads>t`, `<ciFailing>f`,
`<sastPending>sast`, `conflicts` (mergeable CONFLICTING), `pending`
when only pending checks remain, `ok` when clean.

Write surface (what exists today — no herdr badge field yet):

- `workspace rename` → `[<worker>·<pr>] <title>` — `·`-joined tokens,
  same v1 label shape. Title = bead title via slug, else basename.
- `workspace report-metadata` → source `bro.fleet`, token
  `status=<worker>·<pr>` — the same string the label brackets carry
  (e.g. `silent16h·#765 4t/3f/6sast/conflicts`),
  `--clear-token` on vacate; the retired `bro.worker`/`bro.pr`/`bro.gate`
  keys are cleared when still present.

The projection object `{state, silentMin?, pr?, gateFrag?}` is emitted
at the projector boundary so a future herdr badge field consumes
state/severity without recomputing.

### Degradation

No herdr binary/socket → the tick skips quietly and logs once per
reachability transition. A failed single write skips that workspace.
Nothing in the projector may stall or crash `driveOnce`.

## Tests

Classifier matrix: pid alive/dead × cause (ok/rate_limited/quota/none) ×
stopped × PR resolution; live-run-wins over dead records; silent
bucketing; gate fragments. Plugin converge tests updated for the
no-label ownership split.
