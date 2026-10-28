# bro-762eh — herdr connector + thin plugin: bro engine, herdr UI facade

[herdr](https://herdr.dev) is a terminal workspace host: git-worktree-backed
workspaces, panes, agent sessions, and a socket API whose entire surface is
the `herdr` CLI. bro already treats agent backends as a connector seam
(`connectors.agents`: "detached processes, multiplexer sessions, managed
fleets" — `agents.<backend>.command` templates; the two state planes —
beads claim + `bro/agents.json` registry — are backend-agnostic). Herdr is
the multiplexer-session backend that is missing: today every fleet worker
is a detached `sh -c` nobody can watch. This bead adds the connector plus
a thin herdr plugin — the fourth read/UX surface after `bro fleet serve`
(HTTP JSON) and `bro fleet mcp` (tools). **The plugin is a facade, never
the engine: it renders bro planes and forwards user intent to `bro`;
claims, scheduling, exit classification, and the act gate stay in bro.**

Spike findings (validated 2026-10-28, herdr 0.9.5): `herdr worktree open
--path <wt> --label <s>` registers an existing linked worktree as a
workspace and returns `{workspace_id, root_pane.pane_id}` as JSON;
`herdr worktree list` already enumerates *every* bro worktree with
`open_workspace_id` for opened ones — the worktree plane needs no bro→herdr
push, only a join against `bro fleet status --json`. `herdr agent wait
<pane> --until done`, `pane read`, and `session.snapshot` supply exit
detection and the log tail the cause classifier needs.

## Design

- **`agents.herdr` backend** (packages/core agents seam, `native`-shaped):
  - spawn: `herdr worktree open --path {worktree} --label {label}` →
    parse `workspace_id`/`pane_id` from the JSON answer, then
    `herdr pane run <pane> "<agent command>"` (or `agent start` where the
    agent manifest exists). The `agents.herdr.command` template is the
    agent binary itself — same `{promptFile}` substitution as `native`;
    `agents.herdr.workspace` selects an existing workspace instead of
    opening a new one; `agents.herdr.split` declares a pane split spec.
  - identity: `agents.json` entry records `backend: "herdr"`,
    `workspace_id`, `pane_id` — agent identity survives the pane; the
    beads claim is unchanged.
  - exit: a spawn-side watcher runs `herdr agent wait <pane> --until
    done` (bounded) then `pane read --source recent` → log tail → the
    existing exit-cause classifier; `pane closed` ≠ exit code — a closed
    pane with no agent status is `lost`, same taxonomy as native.
  - lifecycle: `bro work enter` stays the worktree maker; herdr's own
    `worktree create` is not used (bro must own the branch/base ref —
    local-main drift is a recorded failure mode). `bro work leave` /
    `worktree remove` closes the herdr workspace best-effort, never the
    reverse.
- **Naming convention** (operator-facing, config-free): worktree slug is
  `<bead>-<short-title>` (`bro-762eh-herdr-connector`), herdr workspace
  label is the bead title; `workspace.rename` resyncs on drift.
- **Occupancy**: a herdr-spawned worker still writes the session `.work`
  markers — the occupancy plane reads it as `green-occupied — session
  armed work on <slug>`; batch lanes never double-spawn into a visible
  pane.
- **herdr plugin** (thin, `herdr-plugin.toml` manifest only, shipped as
  `plugins/herdr/` in this repo — installable via
  `herdr plugin install ThePlenkov/bro/plugins/herdr`):
  - `[[panes]] board` — a TUI over `bro fleet status --json` joined with
    `herdr worktree list` (worktree ↔ bead ↔ agent ↔ PR), `watch -n`
    refresh is acceptable for v1;
  - `[[actions]] open-worktree` (workspace context) — `bro work enter
    <slug>` + `herdr worktree open`; `claim-bead` — `bro flow next`;
  - `[[events]] on worktree.created` → `bro comms notify "herdr worktree
    opened: <path>"` — notify only, never a claim or spawn;
  - link handler for `github.com/.*/pull/\d+` → `bro review act status`.
- **Agent-facing**: the herdr agent skill (`herdr --skill` /
  `npx skills add herdrdev/herdr --skill herdr`) is installed for agents
  running inside panes — `HERDR_ENV=1` is the honesty gate; agents
  outside herdr get no herdr commands in prompts.

## Non-goals

- The plugin does not schedule, claim, spawn, or merge — one executor per
  unit of work stays the rule; herdr panes are a *display* of bro's
  registry, not a second registry.
- No per-agent adapters in bro — herdr's agent manifests own "which agent
  reports which status"; bro consumes `agent_status` only.
- No socket-API client — the CLI wrappers are the contract (they are the
  plugin API per herdr docs); raw socket stays a later optimization.

## Verify

- `agents.herdr` spawn through `bro fleet agents up <step>`: registry
  entry has `backend:"herdr"` + workspace/pane ids; the pane visibly runs
  the agent command in the claimed worktree; `bro fleet agents status`
  reports running→exited with a classified cause from `pane read`.
- Occupancy: a herdr-workspaced worktree shows `green-occupied` on the
  work plane.
- Plugin: `herdr plugin link plugins/herdr` → `action invoke` runs the
  actions; the board pane renders the joined table; `worktree.created`
  drops a mailbox line.
- `npm run build`, `npm run typecheck`, `tsx --test` green.

## Exit criteria

`bro fleet agents up` with `connectors.agents=herdr` lands a worker in a
visible herdr pane in its claimed worktree, drives it to a classified
exit, and the board pane shows the same row `bro fleet status` shows.
