# bro-l8wqu — one human-readable session pane per managed workspace

A bro-managed workspace today shows 3–4 robot surfaces: the
interactive TTY the agent is bound to, a per-agent log mirror, a
`bro: events` bus tail, a `bro: status` LED strip, and (since
bro-nwl5g) a `bro: session` conversation view — stacked together they
are a machine dashboard, not something a human reads. The end state
is **one pane a human reads**: the formatted live agent session
(`bro herdr session-view`), with the fleet LED and the `[status·#PR]`
strip folded into it.

## Step 0 — the transport question (experiment, run first)

**Question:** can a second ACP client process follow a live session
another client owns? `bro herdr session-view`'s ACP leg attaches via
`session/load`; if live updates stream cross-process, the pane design
is "attach and render". If not, the live stream must come from
somewhere else.

**Method** (`.scratch-acp-xproc.ts`, `tsx` over raw NDJSON JSON-RPC):
two `opencode acp` (v2.2.4) processes in one cwd.

- Process A: `initialize` → `session/new` → `session/prompt` a slow,
  many-update task (an 8+ sentence story with a pause/tool call per
  sentence).
- Process B (~3 s into A's turn): `initialize` → `session/load` the
  same sessionId → watch notifications for ~25 s while A keeps
  producing updates.

**Observed:** A's `initialize` negotiated protocol 1 and advertised
`loadSession: true`. B loaded session
`ses_e711ba55cffeLb9FEJm5eZl4MG` successfully and saw **2 updates
replayed during the load call** (a compacted snapshot for ~40 chunks
of history), then **1 `available_commands_update` notification** after
the load resolved — and **zero** of A's turn updates across the
following 25+ s, while A logged 100+ updates on its own wire.

**Verdict:** `session/load` is a **replay snapshot**, not a live
cross-process stream. The loading client gets compacted history plus
session-scoped notices; the owning client keeps the live
`session/update` wire to itself. A viewer process can never follow a
live turn through `session/load` alone.

**`bro acp proxy` evaluation (bead bro-bhyo1):** the proxy is a
verbatim 1:1 forwarding edge — one downstream client, one upstream
agent, a hook seam on the first prompt, and a `bro/proxy/` events
archive. It does **not** multiplex a session to several clients, so it
is not the shared endpoint this design needs either.

**The shared endpoint already exists:** `pumpTurn` (bro-0ppt0) drives
every fleet ACP turn through `agentTurnPlane`, which appends **every
raw `session/update`** — chunks included — to
`<git-common>/bro/agents/<agentId>.events.jsonl`, bookended by
`kind:'turn'` `phase:'start'`/`'stop'` rows. That append-only archive
is the durable, full-fidelity, cross-process live stream the pane
follows: the writer is the headless worker, the reader is the pane,
and neither holds an ACP connection to the other. The pane gains a
`kind:'permission'` row type (written by the acp-worker's permission
handler) so a permission ask — a client-bound request that never
appears in `session/update` — is also observable cross-process.

## Design

### Workspace lanes

Each managed workspace resolves one **lane**, derived from the
existing fleet/agent record (no new flags):

- **acp lane** — the session-owning agent's `providers.<name>` entry
  is `type === 'acp'`. The workspace shows exactly ONE pane:
  `bro: session` running `bro herdr session-view`. The status pane,
  event tail, and per-agent mirrors retire (the session pane folds
  their information in).
- **agent lane** — a live non-ACP agent on the worktree. Today's
  fallback set: the per-agent log mirror + `bro: status` (the
  `bro: events` tail stays suppressed while a mirror lives). The
  session pane retires — for a non-ACP worker it only duplicated the
  mirror.
- **none** — claim/marker-armed workspace with no worker. Today's
  set: `bro: status` + `bro: events`. No session pane.

Lane knowledge lives in the **fleet-state file**
(`<common>/bro/fleet-status/*.json`): the daemon projector — the only
classifier — emits `lane: 'acp'` when the session-owning agent's
provider resolves `type === 'acp'`, plus `events`, the session
owner's `.events.jsonl` archive path. The plugin reads those files
per armed worktree (same read seam the panes already consume) and
includes the lane in the converge diff key, so a projector write
re-runs convergence. Before the first projector write a fresh
workspace takes the non-acp fallback set and converges to the acp set
a tick later — convergent, self-correcting.

### The session pane on an acp lane

`bro herdr session-view` resolves its feed in this order:

1. **events** — `lane: 'acp'` and the fleet-state doc names an
   `events` archive that exists (or whose worker is live): tail the
   JSONL. `kind:'update'` rows feed `AcpRenderer.update` — full
   fidelity, byte-identical to what the worker saw, chunks coalescing
   exactly like the live wire. `kind:'turn'` rows render the
   `── turn complete ──` boundary. `kind:'permission'` rows render the
   ⚠ chip and the verdict the headless driver returned.
2. **acp attach** — `lane: 'acp'` but no archive (a session that
   predates the events plane): the existing `session/load` attach —
   replayed history, readonly posture. Live updates do not follow
   (Step 0); the pane says so.
3. **log** — the session owner's `.log` tail — the non-acp /
   no-archive fallback.
4. **none** — nothing recorded.

**LED contract** — the pane self-reports `agent_status`
(source `bro:fleet`, agent `bro-session`) and is the workspace LED's
reporter on acp lanes:

- `working` — while archive rows stream (turn `start` or any
  `update`), and while the attach is live/connecting.
- `idle` — on `kind:'turn' phase:'stop'` (prompt-complete → the
  bead's "done on end"; herdr has no `done` state, `idle` renders ✓),
  on attach end, and on a dead worker (`exited`/`stopped`).
- `blocked` — on a `kind:'permission'` row the headless driver
  denied/cancelled (the pane surfaces the ask and marks the workspace
  blocked — permission needs human/interactive handling), on a turn
  stop carrying `error`, and on worker `lost`/`interrupted`.
- `unknown` — no projection yet.

The worker verdict from the fleet-state doc (`led`) is the floor: a
blocked worker verdict wins over a stale 'working' session state;
after the worker exits the doc's `idle` matches the session's.

**`bro: status` folds in:** the pane prints the projector's `status`
string (`working·#815 1f` etc.) as a dim transition line whenever it
changes, and carries the title/agent/model in its banner — the status
pane's information without the strip.

**Interactive TTY only on demand:** nothing spawns a TTY pane. A
denied permission prints the ask plus a hint that the session needs
interactive handling; the human opens a terminal in the same
workspace when they want one.

**Readonly stays readonly:** the pane never sends `session/prompt`
(prompts route through bro/herdr CLI); the attach leg still
auto-denies permission asks and now also reports `blocked` for them —
surfacing is the new behavior, denial is unchanged.

### Labels (operator decision)

Managed-workspace labels distinguish the lane: **`🤖 `** stays on acp
lanes (robot does the work — headless, session pane), **`⚙️ `** marks
every other bro-managed lane (interactive arms — claim/marker/loop —
and non-acp workers). Manual workspaces stay unprefixed. The plugin's
open-time `desiredLabel` uses the same fleet-state lane read
(converges when the projector lands); the daemon projector's
`labelFor` takes the projection so one classification writes both
surfaces.

## Changes

- `fleet-state.ts` — `FleetPaneState` gains `lane?: 'acp'` and
  `events?: string`.
- `herdr-projector.ts` — `AgentRow` gains `acp`/`events` (the
  archive path derived from the registry entry's `agentId` + the
  agents home); the session owner lends them to the projection;
  `stateOf` writes `lane`/`events`; `labelFor` takes the projection
  and picks `🤖`/`⚙️`.
- `acp-events.ts` — export `agentEventRecord`, a sibling-row writer
  for out-of-band turn events (the permission ask is a client-bound
  request, never a `session/update`).
- `acp-worker.ts` — the permission handler records a
  `kind:'permission'` row (title + verdict) into the archive beside
  the turn's update rows.
- `herdr-session-view.ts` — events-tail mode + LED/status fold +
  blocked-on-permission reporting; attach mode stays as the
  no-archive fallback.
- `plugins/herdr` — `lanes` read in planes (+diff key), lane-aware
  convergence in reconcile/mirrors/sessions/statuses/renderers,
  `desiredLabel` takes the lane.

## Tests

- `herdr-projector.test.ts` — `lane`/`events` projection fields,
  label prefix per lane, state doc carries both.
- `herdr-session-view.test.ts` — events-mode render (updates,
  turn bookends, permission rows → blocked LED), status-fold line,
  attach fallback order.
- `acp-worker`/`acp-events` tests — a permission ask lands as an
  archive row.
- `plugins/herdr` converge tests — acp lane composes session-only,
  non-acp keeps mirror/status, lane flips retire panes; label per
  lane.

## Out of scope

- Multiplexing a live ACP wire (`bro acp proxy` fan-out) — the events
  archive serves every managed worker today; a multiplexed transport
  is bro-bhyo1's follow-up, not this bead.
- Multi-turn / interactive prompting from the pane — readonly stays
  readonly.
- sessions recorded by `bro acp proxy` (`bro/proxy/` archives) —
  unmanaged sessions have no fleet projection to drive a pane.
