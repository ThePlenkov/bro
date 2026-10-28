# bro-762eh — herdr plugin as bro channel: engine in bro, facade in herdr

[herdr](https://herdr.dev) is a terminal workspace host: git-worktree-backed
workspaces, panes, agent sessions, and a socket API whose entire surface is
the `herdr` CLI. This bead integrates it as a **read/UX facade over bro's
existing planes** — alongside `bro fleet serve` (HTTP JSON) and `bro fleet
mcp` (tools). The governing invariant:

**bro never knows herdr exists.** No `agents.herdr` backend, no socket
client, no push channel. The herdr plugin is an external _reconciler_: it
pulls bro's read planes (`bro fleet status --json`, `bro/agents.json`,
`git worktree list`, `.work` markers) and converges herdr workspaces/panes
to match. Writes into bro happen only as ordinary `bro`/`bd` CLI calls —
forward intent, never implement it. One executor per unit of work stays
the rule; herdr panes render bro's state, they don't own a second copy.

Spike findings (validated 2026-10-28, herdr 0.9.5): `herdr worktree open
--path <wt> --label <s>` registers an existing linked worktree as a
workspace and returns `{workspace_id, root_pane.pane_id}` as JSON;
`herdr worktree list` already enumerates _every_ bro worktree with
`open_workspace_id` for opened ones. `herdr agent start <name> --kind
devin --pane <p>` detects the agent natively and reports `agent_status`
(idle/working/done); `agent prompt <name> <text>` submits a work order
into the live session — one path covers batch and interactive. Pane
lifetime is workspace lifetime: an exited agent closes its pane, and a
workspace that loses its last pane is removed — reconciler must
re-`worktree open` idempotently (`already_open` handles repeats).

## Design — the plugin (`plugins/herdr/`, manifest-only)

`herdr-plugin.toml` + one reconciler command + declared surfaces:

- **Sync loop** (`[[startup]]` + periodic tick, or a `[[panes]]`-backed
  daemon pane): poll `bro fleet status --json` and `herdr worktree list`;
  converge —
  - claimed/armed worktree without a workspace → `herdr worktree open
    --path` + `--label <bead title>`; label drift → `workspace.rename`;
  - native-spawned worker (registry entry, detached) → mirror pane in
    its workspace running `tail -f <agent log>` — read-only visibility,
    engine untouched;
  - exited agent (`.exit` record / registry state) → mark or close the
    mirror pane.
- **`[[actions]]`** — command plane, plain `bro` calls: `open-worktree`
  (`bro work enter <slug>` then `herdr worktree open`), `claim-bead`
  (`bro flow next`), `pr-gate` (`bro review act status` on the
  workspace's branch PR).
- **`[[panes]] board`** — TUI joining `bro fleet status --json` × `herdr
  worktree list` × `herdr workspace list` (worktree ↔ bead ↔ agent ↔
  workspace ↔ PR gate); `watch -n` refresh is acceptable for v1.
- **`[[events]] on worktree.created`** → `bro comms notify` — notify
  only, never a claim or spawn.
- **Interactive lane** — the plugin spawns visible agents itself
  (`agent start --kind <k>` + `agent prompt <work order>`), but writes
  _nothing_ into bro: the spawned agent's own `bro work enter`/`bd
  --claim` creates the claims and `.work` markers, so the occupancy
  plane reads `green-occupied` and batch lanes never double. Plugin is
  clean-of-writes by construction.
- **Naming convention** (config-free): worktree slug `<bead>-<short-
  title>` (`bro-762eh-herdr-plugin`), workspace label = bead title;
  `workspace.rename` resyncs on drift.

## Bro side — read-plane completeness only

No new subsystem. The spec's bro-facing work is an audit: does
`bro fleet status --json` (plus `--deep` where needed) expose everything
the reconciler needs — bead, worktree path, agent id/log path, state,
PR gate? Gaps become their own small additions to the existing JSON
output (e.g. `bro work list --json` if a claims→worktree join is
missing), not a herdr-shaped feature.

## Non-goals

- No bro→herdr push channel, event subscription, or socket client —
  v1 is poll; a `bro comms` event feed is a possible later optimization.
- No agent adapters — herdr's agent manifests own per-agent status
  detection; the plugin consumes `agent_status` only.
- No bro writes from the plugin beyond ordinary documented CLI calls;
  never edits `agents.json`, `.exit`, or beads state directly.

## Verify

- `herdr plugin link plugins/herdr` → sync loop opens a workspace for a
  session-armed worktree with the bead-title label; a native worker's
  mirror pane tails its log; exit marks the pane.
- Actions invoke real `bro` verbs; board pane renders the joined table;
  `worktree.created` drops a mailbox line.
- An agent spawned by the plugin that runs `bro work enter`/`bd --claim`
  shows `green-occupied` on the work plane; no batch-lane double-spawn.

## Exit criteria

With the plugin linked, `bro work enter <slug>` + a claim results in a
labeled herdr workspace and a live agent pane driven by `agent prompt` —
while `git worktree list`, `bd`, and `bro fleet status` remain the only
state bro itself keeps.
