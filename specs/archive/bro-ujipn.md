# bro-ujipn — `agents.devin.maxWorkers`: a worker-only session quota

## Problem

`agents.<kind>.maxSessions` counts every live session of a kind — the
user's interactive `devin` TTY sessions AND spawned acp/headless
workers share one pool. N interactive sessions eat the cap and rigs
starve on `spawn-refused` even though each rig already self-limits via
`fleet.maxConcurrent`. Seen live: sverka drive refused 4/4 spawns with
3 of 4 slots held by user TTYs and 1 by a bro acp-worker — one worker
slot for the whole host is too tight for a multi-rig fleet.

## Design

Split the admission counter in two lanes, both checked under the same
host-wide mutex (`admitSessionSlot`):

- **`maxSessions`** — unchanged: total live sessions of the kind. The
  host-safety net (a runaway fleet can never flood the host past it).
- **`maxWorkers`** (new) — only *spawned* sessions count: the plane's
  `countWorkers` plus held `.slot` reservations (every admitted spawn
  is a worker by construction). A slot retires as soon as the plane
  can see the spawn's own session mark — a landed worker counts once,
  not live+reservation twice. Interactive sessions never consume
  this budget, so `maxWorkers: 2` lets two rigs run one worker each no
  matter how many `devin` TTYs the user has open.

Both keys ride `agents.<kind>`; absent or `0` keeps the lane uncapped
(same off-convention as `maxSessions`/`fleet.maxConcurrent`). A quota
exists when either lane is armed — `maxWorkers` alone is a legal
config. A present-but-malformed value in either key flags `invalid`
and refuses `'config'` at admission, naming the bad key.

### Plane contract

`SessionPlane` gains an optional `countWorkers(bag, workerEnv)` —
live sessions of this kind that are spawned workers. A plane that
cannot tell workers from interactive sessions leaves it unimplemented;
arming `maxWorkers` on such a plane is a config bug and admission
refuses `'config'` loudly rather than spawn past a quota the operator
armed (same convention as `sessionKind` with no registered plane).

### Worker detection — devin plane

A live-pid lock classifies as a worker when either /proc probe holds:

1. **`BRO_AGENT_ID=` in `/proc/<pid>/environ`** (NUL-anchored) — the
   spawn-plane badge every backend pins into the worker's env
   (`agentEnvPins`); inherited by the devin child a wrapper spawns, so
   `bro acp-worker → devin acp` and `sh -c 'devin -p …'` both carry it.
2. **stdin is not a terminal** — `/proc/<pid>/fd/0` resolves outside
   the terminal devices (`/dev/pts/*`, `/dev/tty`, `/dev/console`,
   `/dev/tty*` — pty slaves, the controlling-terminal alias, and
   virtual/serial consoles). Interactive `devin` reads a terminal;
   headless workers (pipes, files, `/dev/null`) do not. This also
   catches non-bro headless sessions like an editor's `devin acp`.

A pid that verifies neither probe is NOT a worker — unreadable
environ/fd undercounts the worker lane, degrading toward pre-split
behavior (workers share the `maxSessions` ceiling when it is armed).
The alternative — treating the unverifiable as workers — would let
phantom workers refuse real ones, re-creating the starvation this
split removes. A host with NO `/proc` at all (macOS) cannot classify
a single session: the plane then reads as "cannot tell workers" and
an armed `maxWorkers` refuses `'unavailable'` at admission rather
than silently unguard — pair the lane with `maxSessions`, the
platform-independent ceiling, for a guaranteed guard there.

A manual `devin -p` typed at a TTY keeps its pty stdin and reads as
interactive — an accepted edge: it still counts under `maxSessions`,
and the worker lane exists to protect rigs, not to police the user.

### Non-goals

- Per-repo worker budgets — the lane stays host-wide, like the session
  lane; `fleet.maxConcurrent` is already the per-rig cap.
- Lock-file format changes — detection is all /proc reads over the
  existing `<name>.lock` pid files; nothing new is written.
- Retroactive classification of `AI_AGENT`-badged sessions — that
  badge marks agent runtimes generally (an interactive session may
  carry it); only `BRO_AGENT_ID` proves a spawned worker.

## Surfaces

- `agents.devin.maxWorkers: <n>` — config key.
- `bro agents status` — `devin workers: <live>/<max> live` row beside
  the existing sessions row when the lane is armed.
- Refusals: `devin worker quota reached — <live>/<max> live workers
  (agents.devin.maxWorkers in bro.config) — spawn of <step> refused`.

## Tests

- `sessionQuotaConfig`: maxWorkers parse/off/invalid, either-key arms
  the quota, bad key named.
- `admitSessionSlot`: worker cap refuses at ceiling, interactive-only
  sessions never fill it, reservations feed the worker count, missing
  `countWorkers` + armed `maxWorkers` → `'config'`, a slot the plane
  retired inside its count is not double-counted.
- devin plane: badge → worker, non-tty stdin → worker, pty/tty/
  console stdin → not, dead pid → not, unverifiable → not; a landed
  worker's slot is swept out of the reservation tally; `/proc` absent
  + live sessions → `'unavailable'`.
- `bro agents status` renders the workers row.
