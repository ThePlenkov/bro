---
parent: fleet-routing
scope:
  - packages/core/src/routing.ts
  - packages/core/src/config.ts
  - packages/core/src/agents.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/convoy.ts
  - packages/cli/src/commands/convoy-run.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/commands/next.ts
  - packages/providers/src/acp-worker.ts
  - skills/convoy/
  - skills/next/
---

# bro-1x7p — dispatch arbiter: provider tiers, quota fallbacks, shell-native workers

Spec for `bro-4sn6` (fleet routing — context/quota-aware agent
dispatch). Pinning the design before the epic decomposes.

## Problem

Spawn provider selection is static today: `agents.<backend>.provider`
or a `fleet.profiles.<name>` preset names ONE provider, chosen by the
caller. The exit-cause taxonomy (bro-7xgk.2) already knows when a
death was a provider wall — `rate_limited` with `resetAt`, `quota` —
but the answer is always "wait the same provider out or refuse". Two
wastes follow:

- A rate-limited `devin` worker idles until reset while a free-tier
  provider (`kilo` auto/free, `opencode/zen`) could run the step now.
- A quota-walled provider holds every step that names it, including
  trivial sweeps that would cost a frontier plan nothing.

Resume is also all-or-nothing. A `cli` worker's only recovery is a
fresh process — fine — but an `acp` worker that died mid-turn restarts
a fresh `session/new` even though the registry already pins
`acpSessionId` and the protocol has `session/load`. And two
orchestration habits fight the model: opaque subagent sessions the
facade can't see, and infinite `--every` watchers whose notifications
only reach an already-awake session. Finally, a session that finishes
its unit stops dead — the stop-gate blocks the exit but nothing feeds
the next work order in.

## Terms

- **task class** — a named lane (`sweep`, `feature`, `critical`,
  `default`) the routing table maps to an ordered provider chain.
- **provider chain** — the ordered list of `providers.<name>` entries
  a class tries, cheapest acceptable last.
- **provider wall** — a provider-level blocked state derived from the
  provider's unstopped *wallable* deaths (`rate_limited`, `quota` —
  `crash`/`auth` never join the scan): `rate_limited` walls until
  `resetAt` (indefinitely when none was reported), `quota` walls
  until the operator clears the record.
- **park vs fall** — a walled step's two verdicts: *park* waits the
  wall out on the current provider; *fall* re-dispatches the step to
  the next un-walled chain entry.
- **shell unit** — a convoy step materialized as a pinned detached
  shell (`sh -c` spawn, own process group, `pid`/`log`/`exit` under
  `<git-common>/bro/agents/`) — the native backend's existing shape,
  now the formula's explicit contract.
- **continuation event** — a mailbox drop telling a live session its
  queue advanced; the wake feed the stop-gate never had.

## Routing table

`fleet` gains a `routing` section — task class → ordered provider
chain:

```jsonc
{
  "fleet": {
    "routing": {
      "default":  { "chain": ["devin", "kilo-free", "opencode-zen"] },
      "sweep":    { "chain": ["kilo-free", "opencode-zen"] },
      "critical": { "chain": ["devin"], "onWall": "park" }
    },
    "router": { "provider": "typesafe", "mode": "shadow" }
  }
}
```

- Every chain entry MUST resolve to a configured `providers.<name>`
  entry with a spawn surface (`acp`, `cli`) — an `api` entry or an
  unknown name is a config error naming class + key, same rule as
  `agents.<backend>.provider`. Entries may pin `model` inline
  (`{ "provider": "devin", "model": "swe-2-high" }`) where the bare
  string form isn't enough.
- `onWall` is the class's wall policy: `park` (wait the current
  provider's wall out — for work that must not degrade) or
  `fallthrough` (walk the chain). Default by priority: P0/P1 park,
  P2+ fallthrough; `onWall` overrides per class.
- **Class resolution** — total precedence, first hit wins: the
  `StepSpawnRequest.class` field / `bro agents up --class` → the step
  bead's `class:<name>` label → `default`. A resolved class with no
  `routing` entry is a config error, not a silent `default` — same
  no-silent-fallthrough rule as provider names.
- **Absent `routing` = today's behavior.** No section → the existing
  profile/provider/template resolution stands untouched. bro never
  picks a route the operator didn't declare — the "0 disables"
  precedent.

### Optional judge router

`fleet.router.provider` names a call-surface provider that classifies
an unclassed step: the step's title/description goes in, a typed
`choice` over the declared classes comes out. Mode rides the
judgments ladder — `shadow` journals the verdict beside the resolved
class, `enforce` lets it pick. `off`/absent = static classes only.
The router never invents a class and never picks a provider directly
— it answers *which lane*, the table still owns the chain.
`enforce` holds the typed promise: it requires the provider's
resolved call grade to be `typed` — an `api` entry on the systemone
wire or an `acp` entry on a jev-family model. A prose-grade entry
(`cli`, an `openai-compat` model, a non-jev `acp` pin) under
`enforce` is a config error naming provider + mode, never a silent
demotion; `shadow` accepts prose — the verdict journals with its
`:prose` stamp and picks nothing.

## Provider walls — derived, not stored

A provider's wall state is **computed from `agents.json`**, not kept
in a new store: scan the registry for death records attributed to P —
an entry's live fields plus each `attempts` record a re-dispatch left
behind (below) — and keep only the unstopped *wallable* ones: `quota`
dominates, walling P until every quota-caused record on P is
`stopped` (`bro agents down` is the manual clear — its `stopped`
stamp covers the entry and its `attempts` alike, same as today);
otherwise the newest `rate_limited` death (by `spawnedAt`) walls P
until its `resetAt`, indefinitely without one — a passed `resetAt` is
the lift. `crash`/`auth` never wall a provider — they say something
about the worker, not the service — and they never join the scan: a
fresh crash on P postdates but doesn't displace an unexpired
rate-limit wall.

`bro fleet` renders a walled provider as `walled — <cause>[ til
<resetAt>]`; `bro watch` surfaces it in attention. Derivation has one
honest caveat, documented not hidden: a rate limit one worker hit may
be per-account RPM — provider-wide — or per-key/session — not. The
wall is pessimistic (better to route around a healthy provider than
retry-storm a walled one); a `resetAt` passing is the proof of lift.

## Re-dispatch — the chain walk

`prepareSpawn`'s respawn refusal becomes **provider-scoped**: a block
forbids re-running the step on the *same* provider while it holds,
never the step itself. The respawn seam resolves the class chain and
walks it from the step's current position (the registry entry's
recorded `provider`) to the first un-walled entry:

- un-walled entry found + policy `fallthrough` → spawn there; the
  registry patch records the NEW `provider`/`model` — provenance says
  what ran, not what was preferred. One row serves one step, so any
  respawn patch that supersedes a classified death first appends the
  outgoing attempt's fields (`provider`, `model`, `cause`, `resetAt`,
  `spawnedAt`, `stopped`) verbatim to the entry's `attempts` list —
  otherwise the overwrite erases the very wall the walk routed
  around, and every later step retries provider A.
- policy `park`, or every chain entry walled → the step stays
  `blocked` against its current provider; `resetAt` passing (or
  `agents down`) is the lift. A step with an exhausted chain parks on
  its LAST entry — the dead-letter verdict, surfaced by `bro watch`,
  never silently dropped.

Single-provider chains reduce to today's semantics exactly. The walk
runs inside the same locked spawn critical section bro-f4ot pins —
dedup, wall check, claim, start stay atomic.

## Resume semantics — per provider kind

| kind | session? | stopped-without-result → |
| ---- | -------- | ------------------------ |
| `acp` | `acpSessionId` pinned on the entry | **ping/resume**: `session/load` on the recorded session id where the agent advertises it; capability absent → fresh `session/new`, noted in provenance |
| `cli` | none | **respawn + rehydrate**: new process; the prompt is regenerated from live beads state (`convoy next` inputs, the claim, the prior log tail) — never a replay of the stale prompt file |
| `api` | no spawn surface | never a chain entry |

The session id is lifted at the clear point: `prepareSpawn` already
holds the dying `existing` entry inside the registry lock, so it hands
the `acpSessionId` it wipes back to the caller, and the resume-capable
backend carries it to the worker (a `resumeSessionId` on the spawn
payload). Neither shortcut works — a bare `resume` flag carries no id,
and any `entry.acpSessionId` read after `prepareSpawn` sees the field
already cleared. The contract: a session-capable provider gets the
chance to continue its own session before paying for a new one.
bro-5hx1.1 deferred `session/load` as "earns a spec when a consumer
needs it" — this is that consumer.

## Shell-native workers — the formula contract

Convoy step kinds gain explicit machinery: a step declares `agent`
(provider-routed worker — the default today) or `run` (a shell unit —
literal `sh -c` command, pinned `pid`/`log`/`exit` in `bro/agents/`
through the same registry). The orchestrator point-checks both through
`bro agents status`/`bro fleet` — a `run` step is a first-class
watchable unit, not an invisible nested session. **No opaque subagent
sessions unless a step explicitly requests one**: the molecule that
wants a session inside a session says so; everything else is a shell
the watchdog can see.

## The watcher rule

Invariant, not guidance: **every watcher bro spawns is finite** —
either bounded (interval × count, or an until-condition whose
satisfaction exits) or event-dying (a per-task wait that exits on its
event: convoy drain, `act wait` on a PR gate, `mesh wait` on a
terminal thread). The wake primitive is the finite process whose exit
IS the event. Infinite `--every` supervision loops are banned — their
`--notify` reaches only a session that is already awake, so they are
telemetry buffers, never wakes. Commands that supervise
(`convoy run`, `drive`, `watch`) audit against this rule; a new
watcher without an exit condition does not merge.

## Continuation — the session feeds itself

The default loop is in-session continuation; `bro convoy run` stays
for explicit parallel fan-out:

1. `bro convoy done` (and bead close on a mol step) emits a mailbox
   drop — `bro notify --to <sessionId|orchestrator> --kind result` —
   when the DAG advances: a new ready step, a gate now waiting, or
   `complete`. The claiming session id rides the beads claim.
2. The drop lands mid-turn via the existing postTool probe — the
   session learns "your queue moved" without a poll loop.
3. Skill text (convoy/next) closes the loop: on completing a unit the
   agent runs `bro convoy next --mol <m>` or `bro next` — same
   session, next work order. The stop-gate remains the net for
   sessions that try to leave with armed work; the mailbox is the
   feed that makes staying worthwhile.

## Non-negotiables

- **Contracts stay vendor-blind.** Routing resolves *names* into the
  same `SpawnSpec.provider`/`model` opaque labels — no new field leaks
  vendor semantics upward.
- **No undeclared routes.** Absent `fleet.routing` = today's static
  resolution; a class or provider that doesn't resolve is a config
  error, never a fallthrough.
- **Provenance follows dispatch.** The registry records the provider
  that RAN the step; a chain walk that fell to `kilo-free` says so.
- **Walls are honest and clearable.** Derived from recorded deaths —
  superseded ones ride `attempts`, so a fallthrough never erases the
  wall it routed around — bounded by `resetAt` when the provider
  reports one, cleared by `bro agents down` when it can't.
- **Watchers are finite.** Exit condition or nothing — telemetry loops
  are not supervision.
- **Parked ≠ lost.** An exhausted chain surfaces as a parked verdict
  in `watch`/`fleet`, not a silent skip or a forced respawn.

## Filetree

```text
packages/core/src/routing.ts          RoutingTable types, class → chain
                                      resolution, provider-wall derivation
                                      (scan agents.json — live fields and
                                      attempts), park/fall verdict
packages/core/src/agents.ts           the entry's `attempts` — superseded
                                      death records walls still derive
                                      from; `bro agents down` stamps them
packages/core/src/config.ts           fleet.routing + fleet.router sections
packages/cli/src/agent-connectors.ts  provider-scoped respawn block; chain
                                      walk in prepareSpawn/spawnStepAgent;
                                      prepareSpawn hands the cleared
                                      acpSessionId back for resume
packages/cli/src/commands/agents.ts   --class flag; StepSpawnRequest.class
packages/cli/src/commands/fleet.ts    provider wall rendering
packages/providers/src/acp-worker.ts  session/load resume path
packages/convoy/                      step kind 'run' — shell-unit contract
packages/cli/src/commands/convoy.ts   convoy done → mailbox emission
skills/{convoy,next}/                 continuation + finite-watcher text
```

## Milestones

1. `bro-1x7p` this spec.
2. `fleet.routing` config + class resolution + provider-wall
   derivation; `bro fleet`/`bro watch` render walls.
3. Re-dispatch — provider-scoped blocks + the chain walk in
   `prepareSpawn` (with `attempts` preservation); priority park/fall
   policy.
4. Resume — `acp` `session/load` on `acpSessionId`, `cli` rehydrated
   respawn.
5. Shell-unit step kind (`run`) in the convoy formula; watcher-rule
   audit across `convoy run`/`drive`/`watch`.
6. Continuation — `convoy done` mailbox emission + skill text; the
   in-session loop becomes the default.
7. Optional judge router — `fleet.router` shadow → advisory → enforce.

## Risks named up front

- **Wall false-positives.** One worker's rate limit may not be the
  provider's. Pessimistic derivation accepts this — routing around a
  healthy provider wastes seconds; retry-storming a walled one wastes
  the budget the taxonomy exists to protect.
- **Chain deadlock.** Every entry walled + `park` policy = a parked
  fleet. It's the intended verdict (loud in `watch`), but the
  dead-letter path needs its own alert surfacing, not just a state.
- **Resume fidelity.** `session/load` is capability-gated per agent —
  the fallback (fresh `session/new` with the rehydrated prompt) must
  be the spec'd path, not an afterthought, or half the fleet silently
  loses continuity.
- **Prompt drift on rehydrate.** Regenerating from beads state means
  the worker sees *current* truth — but a step whose description
  changed mid-flight resumes into a different work order. The claim's
  version (updatedAt) lands in the prompt so the drift is visible.
