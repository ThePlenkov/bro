# bro-f4ot mega-plan — execution DAG

Agent-delegatable decomposition of the agents-facade epic. Every node is a
bead; edges are `blocks` deps; each bead links back via `spec:`.

## Waves

```text
wave 0 (human): merge this spec → main
wave 1 (parallel):
  spike-gascity        bro-4bkv  research, no code — verdict bead
  agents-facade        bro-g4vn  contract + registry + native connector
wave 2 (needs bro-g4vn):
  fleet-one-shot       bro-vf1j  bro fleet table over facade.list()
  agents-supervisor    bro-q0f2  bro agents up/down + agentId registry +
                                 respawn-on-lost (the watcher becomes code)
  bro-serve            bro-dr1s  facade host (HTTP/JSON or MCP) for clients
wave 3 (needs bro-g4vn; gascity-connector also needs bro-4bkv green):
  gascity-connector    bro-cduq  only if bro-4bkv green
  tmux-connector       bro-uqkr  interactive panes backend (facade only)
wave 4 (polish):
  fleet-live-tui       bro-n54z  --live refresh     [needs bro-vf1j]
  fleet-webui          bro-1rir  site route over bro serve [needs bro-dr1s]
  paseo/cao connectors — later, issue-first per external-repo rules
```

## Delegation mechanics

Each wave-1+ bead pours `ship-bead` — tracked at
`formulas/ship-bead.formula.toml` and installed into `.beads/formulas/`
by `bro setup --beads` — → convoy session in own worktree. `bro fleet`
(once wave 2 lands) is the supervisor that monitors the convoys building
it — the system observes itself.

Gates: the ship-bead proto takes `merge=auto|human` — `auto` (the convoy
default) covers the merge inside the act formula via `bro act wait --merge`
armed in-session or by a driver; `--var merge=human` pours a human
merge-gate per PR instead.

## Risks named up front

- gascity may not expose spawn/list/stop surface → connector deferred,
  native stays the path (decided by bro-4bkv, not assumed).
- `agentId` stability across respawn: registry in the common git dir
  (`bro/agents.json`, atomic write) — defined in spec.md.
- facade contract frozen at `spawn/list/stop/status/capabilities`;
  enrichment (attach, logs, resources) is capability-declared, not assumed.
