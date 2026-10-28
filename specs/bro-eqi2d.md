# bro-eqi2d — spawn guard invariant: bro NEVER invokes an ACP session while another (external/interactive) agent is active, and never exceeds the configured quota — across ALL providers

## Problem

Spawn admission today gates on the fleet cap (registry only), the derived
provider wall, claims and worktree occupancy. Nothing on the path can see an
agent bro did not spawn: an interactive devin session, an opencode TUI, a
copilot task another tool dispatched, a foreign headless worker. The
blindness is documented in `BUDGET_LIMITS` — "counts bro registry agents
only — interactive sessions and foreign tools are invisible".

The account is shared (spec bro-9h86l): an interactive session and a bro
batch worker draw on the same budget. A fleet spawn that lands while the
operator is mid-session burns the same allowance and both die on the same
-32010 wall. Two invariants must hold for every `prepareSpawn` path —
loop queue, daemon drive fixers, `bro fleet agents up`, convoy, the
registry backends:

1. **External-agent exclusion** — while an agent this rig does not own is
   actively working, bro refuses to start a session, on any provider.
2. **Quota ceiling** — the session-quota lanes and provider walls keep
   refusing on their own; the exclusion gate is a second, independent
   guard, not a replacement.

## Design

### External activity planes

A new plane family in `@broject/core` (`external-planes.ts`), parallel to
the session-plane registry: each plane answers "is an agent this rig does
not own actively working, and when did it last prove activity?"

```ts
interface ExternalActivity {
  active: boolean;
  detail?: string; // "interactive devin session 'perfect-peach' (pid 1521)"
  activityAtMs?: number; // freshest proven activity stamp
}
```

The probe ctx carries `dir` (repo root), the full `agents` knob map (a
plane's overrides ride `agents.<kind>` like the quota planes), the spawn's
worker env, `env`, `holdMs`, `now`.

**Bro-owned vs external.** A session is the fleet's own when its environ
carries `BRO_AGENT_ID` (every backend pins it — agentEnvPins) or
`BRO_HOOKS=0` (the acp provider pins it on pooled peer children —
serve/conductor's `devin acp`, judge turns). Everything else that is live
is external — interactive sessions, foreign `-p` workers, foreign tools.
An UNREADABLE environ cannot prove ownership: the session counts as
external (fail closed, same convention as `countBatchWorkers`).

**Idleness.** "Active" needs an activity STAMP inside the hold window
(`spawn.externalIdleSec`, default 480s). A live session whose stamps are
all older has gone idle and does not block. A live session with NO
readable stamp cannot prove idle — it counts as active.

- **devin** (`@broject/devin`): the lock-dir scan the quota plane already
  runs, kept per-session. A live session is external when its environ
  carries neither badge. Activity = the freshest of the session's
  transcripts (`transcripts/<name>.json` — every lock name for the pid,
  a resumed session writes under its second lock's name) and its own
  log (`logs/devin_*_<pid>.log`) mtimes, searched under the worker's
  effective XDG base as well as the spawner's.
- **opencode** (`packages/cli/src/session-planes/opencode.ts`): a /proc
  scan for live `opencode` processes — the plane has no lock dir. External
  by the same environ predicate. Activity = the freshest mtime of the
  host's opencode state (`opencode.db`, `opencode.db-wal`, `log/*.log` —
  `agents.opencode.dataDir`/`procDir` override for tests).
- **copilot** (`session-planes/copilot.ts`): remote tasks have no idle —
  a live task is a working runner. The cached `live-count.json` ids minus
  the taskIds this repo's registry spawned (a bro-dispatched task is
  bro's however long it runs) are external. Absent/stale/corrupt cache =
  cannot see → the plane reports quiet rather than inventing remote state.
  The probe itself is synchronous and cannot fetch, so the resolved
  connector's spawn is wrapped with a preflight refresh
  (`primeCopilotForExternalGuard`) — outside the registry lock,
  independent of any copilot quota, skipped while the cache is fresh —
  so a copilot-unarmed rig still refuses beside a foreign remote task.
- **session-markers** (`session-planes/markers.ts`): `<git-common>/
  bro/hooks/*.work`/`*.task` markers — an interactive session's arm is
  proof an agent works in this repo. A marker counts when its owner pid
  is alive, the owner's environ lacks the bro badges, and the marker's
  mtime sits inside the idle window; the mtime is its activity stamp.
  Two populations never count: ownerless markers (no verifiable agent
  owner — a human shell's `bro work enter` arm is not an agent session,
  and bro's own writers drop the owner when starttime is unreadable, so
  counting them would refuse our own spawns; the devin/opencode planes
  carry the fail-closed ownership cases) and markers whose owner is
  dead — residue, not a session.

### The gate

`prepareSpawn` runs `enforceExternalGuard` after the wall refusal, before
fleet admission: claim conflicts still win (they name an owner, not a
capacity), the wall stays ahead because it is registry-derived and cheap,
and the refusal lands before any reservation is claimed. Refusal is
`SpawnError('cap')` — transient pressure the loop holds for the next pass,
surfacing `external agent active — <kind>: <detail>`.

Config: new core `spawn` section — `externalBlock` (default true; false
disables the guard outright) and `externalIdleSec` (default 480, the idle
window). `AgentConnectorEnv.spawn` carries it; `loadAgentEnv` picks it up
with the other core sections.

### Independence of the two guards

The exclusion gate never admits on the quota lanes' behalf and vice
versa: with external activity the spawn refuses `external agent active`
even at empty quota; with external quiet the session-quota lanes, fleet
cap and provider walls refuse exactly as before. Tests assert both legs.

## Verify

- `packages/core/src/external-planes.test.ts` — registry mechanics and the
  report shape.
- `packages/devin/src/external.test.ts` — scripted locks + /proc: a
  badged worker is not external, a foreign `-p` session is, an
  interactive session past the idle window releases, an unreadable
  environ counts external, transcript/log mtimes drive idleness.
- `packages/cli/src/session-planes/external.test.ts` — opencode/marker
  probes on scripted proc + data dirs.
- `packages/cli/src/agent-connectors.test.ts` — the refusal matrix on a
  stub plane: external active refuses 'cap' at empty quota; a walled or
  capped lane refuses with external quiet; `externalBlock:false` admits.
- Live: `bro loop`/`bro drive` log `spawn-refused … external agent
  active` beside an active interactive session.
- docs: AGENTS.md records the invariant; `BUDGET_LIMITS` stops claiming
  foreign sessions are invisible.
