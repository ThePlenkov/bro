# bro-f4ot mega-plan — execution DAG

Agent-delegatable decomposition of the agents-facade epic. Every node is a
bead; edges are `blocks` deps; each bead links back via `spec:`.

## Waves

```text
wave 0 (now, human): merge this spec → main
wave 1 (parallel):
  spike-gascity        bro-4bkv  research, no code — verdict bead
  agents-facade        bro-x     contract + registry + native connector
wave 2 (needs facade):
  fleet-one-shot       bro-vf1j  bro fleet table over facade.list()
  agents-supervisor    bro-x     bro agents up/down + stable agentId +
                                 respawn-on-lost (the watcher becomes code)
  bro-serve            bro-x     facade host (HTTP/JSON or MCP) for clients
wave 3 (needs verdict + facade):
  gascity-connector    bro-x     only if spike green
  tmux-connector       bro-x     interactive panes backend
wave 4 (polish):
  fleet-live-tui       bro-x     --live refresh
  fleet-webui          bro-x     site route over bro serve
  paseo/cao connectors bro-x     external, issue-first per repo rules
```

## Delegation mechanics

Each wave-1+ bead pours `ship-bead` → convoy session in own worktree.
`bro fleet` (once wave 2 lands) is the supervisor that monitors the
convoys building it — the system observes itself.

Gates: human merge-gate per PR (formula default), except spec/docs-only
PRs may `act wait --merge` armed by the orchestrating session.

## Risks named up front

- gascity may not expose spawn/list/stop surface → connector deferred,
  native stays the path (decided by bro-4bkv, not assumed).
- `agentId` stability across respawn needs a registry in the common git
  dir (like `.work` markers) — facade bead must define it.
- facade contract frozen at `spawn/list/stop/status/capabilities`;
  enrichment (attach, logs, resources) is capability-declared, not assumed.
