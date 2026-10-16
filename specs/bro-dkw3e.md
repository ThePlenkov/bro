# bro-dkw3e — occupancy must not count monitors

`agentProcessesIn` marks a worktree occupied when a live process is
(a) cwd'd inside the tree and (b) agent-shaped — where "agent-shaped"
means the process OR any ancestor within 16 hops carries an agent
cmdline or the `BRO_AGENT_ID`/`AI_AGENT` env badge.

That ancestry leg is correct for the raced-spawn problem it was built
for (bro-pywx): a worker's tool shells inherit the badge. It is wrong
for **monitors**: `bro watch`, `bro serve`, an `act wait`, or a bare
shell parked in the tree all inherit the same badge from the agent
session that launched them — and they never do work in the tree. The
occupancy probe then reports the PR occupied forever and the fixer
never spawns (sverka #356 stalled on exactly this).

## Change

`agentProcessesIn` drops a candidate whose *own* cmdline is
monitor-shaped — the shape test reads the process's own argv, never
its ancestry:

- **bro monitor verbs** — any positional after the CLI entry matching
  `watch|wait|status|serve|pulse|notify|daemon` (covers `bro watch`,
  `node dist/index.js serve`, `review act wait`, `setsid bro watch`).

Shells stay workers by prior ruling: a bare `bash` inside the tree is
indistinguishable from a raced worker's tool shell (bro-pywx), and a
false-positive occupancy only delays a fixer where a false-negative
double-works the bead.

Everything else is unchanged: registry/marker planes are untouched,
`procAgentPid`/`procAgentRoot` keep the ancestry walk for owner
tagging, and `processesRootedIn` (the removal guard, bro-1usa8)
deliberately stays wider — a monitor still justifies *keeping* a
tree; it just must not keep a fixer out.

## Non-goals

- No .work-marker requirement on the proc plane — that would
  reintroduce the raced-spawn blind spot the scan exists for.
- `processesRootedIn` unchanged: removal guards stay conservative.

## Verify

- Fake-/proc tests: `bro watch`, `node dist/index.js serve`,
  `review act wait` (badge-carrying, cwd in tree) → not counted;
  `sh -c`, `devin -p`, tool shells → counted.
