# bro-ggjdy — devin workers surface as connector rows, not a bare count

## Problem

`bro agents status` reported devin sessions only as `devin workers: N/M live`
through the session plane's quota view — `agents.json` held native rows for
loop-spawned devin workers while `bro agents status --connector devin` errored
"not registered". External sessions (interactive `devin`, MCP-created, legacy
spawn paths) existed nowhere except the count: no id, no step, no log reach.

## Design — a READ-MOSTLY `devin` agent connector

The devin connector projects `devinSessionPlane.listLive` into `AgentInfo`
rows. Every registered backend's `list()` already rides
`collectAgentBackends`, so `bro agents status`, `bro agents log`, and the
`/api/v1/agents` board pick the rows up with no surface wiring.

- `id` — the worker's `BRO_AGENT_ID` environ badge when present (the
  discovered-session fold already keys on it), else `devin:<lock-name>` —
  the session's own `devin --resume` ref.
- `molStep` — `BRO_BEAD_ID` pin → agentId → session name → `external`.
  An unbadged interactive session names itself, never a phantom step.
- `pid`, `worktree` (`/proc/<pid>/cwd`), `log` (newest
  `devin_*_<pid>.log` under the data dir's `logs/`).
- Registry dedup: a session whose badge is already claimed by a registry
  entry folds out — the owning backend's row represents that work, so
  native-spawned devin workers keep their claim/log/exit artifacts and
  never double-report.

`spawn()` refuses with a config `SpawnError`: bro-spawned devin workers
ride the **native** backend so the registry pins step/log/exit — the one
shape `agents up` must keep producing. `stop()` SIGTERMs the session pid
(idempotent; devin sessions are not detached group leaders, so no group
signal). `capabilities()` reports `{ supervisor: 'none' }`.

The connector is a protected built-in: `'devin'` joins
`BUILTIN_AGENT_BACKENDS` so fixture cleanup cannot unregister it, and it
registers LAST — `firstAgentConnector` still resolves `native`.

## /proc provenance

- `devinPidAgentId` / `devinPidBead` read `/proc/<pid>/environ` for the
  NUL-anchored `BRO_AGENT_ID`/`BRO_BEAD_ID` pins (unreadable → undefined,
  the plane's undercount contract).
- `devinPidCwd` reads `/proc/<pid>/cwd`.
- `devinPidLog` picks the newest `devin_*_<pid>.log` in `devinLogsDir`
  (sibling of `session_locks`; `agents.devin.logsDir` overrides).
- `agents.devin.procDir` injects a scripted /proc for tests — same
  override convention as `lockDir`/`logsDir`/`reservationsDir`; `listLive`
  and the connector both honor it.

## Board dedup — two projections, one session

The fleet board renders both `backends[].agents[]` and `discovered[]`.
A devin session listed by the connector would appear twice (once as the
`devin:<name>` backend row, once as the session-plane discovered row).
The discovered fold now also keys `byId[s.kind + ':' + (s.name || s.pid)]`
— the same name shape the connector's id uses — so the discovered row
folds into the connector row's `session` column instead of duplicating.
A badged session folds by `agentId` as before.

## Degradation contract

`list()` never throws into the board: an unreadable lock dir yields
`{ agents: [], degraded }` — the same fail-open note other backends use
for a broken state dir. The session plane's own count/list verbs keep
their fail-closed `SpawnError('unavailable')` — the connector translates
it, it does not weaken it.

## Tests

`agent-connectors.test.ts` — `describe('devin connector')`:
- unbadged live session → `devin:<name>` row with pid/worktree/log;
- badged worker → `id=agentId`, `molStep=BRO_BEAD_ID`;
- registry-claimed badge → folds out (no duplicate);
- `status` finds by name suffix and agentId, `AgentNotFound` on miss;
- `spawn` refuses `SpawnError('config')`, claims nothing;
- `stop` SIGTERMs a real child pid, idempotent once gone;
- unreadable lock dir → `degraded`, not a throw;
- `'devin'` is a protected built-in, never first in registry order.

Registry-order assertions (`resolveAgentConnector`, `eachAgentConnector`,
gascity, copilot "last builtin") updated for the trailing `'devin'` entry.
`devin.test.ts` — the plane already covered locks/workers/listing; the
`procDir` bag override rides `devinProcDir` into `listLive`.
