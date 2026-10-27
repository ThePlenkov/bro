---

parent: bro-5hx1
scope:
- packages/providers/src/acp.ts
- packages/providers/src/acp-worker.ts
- packages/providers/src/testkit.ts
- packages/core/src/agents.ts
- packages/cli/src/agent-connectors.ts
- packages/cli/src/commands/acp-worker.ts
- packages/cli/src/commands/agents.ts
- packages/cli/src/commands/serve.ts
- packages/cli/src/commands/loop.ts
- packages/cli/src/commands/drive.ts
- packages/loop/src/prompt.ts
- bro.config.json

---

# bro-5qsnr — fix rounds must resume the coder's own devin session in its worktree — never a fresh third-party fixer while the session lives

Parent design: `specs/bro-5hx1.1.md` (acp worker driver — this spec is the
`session/load` consumer its resume note deferred to). Resume model:
`specs/fleet-routing/bro-1x7p.md` §Resume semantics (`acpSessionId` lifted
at the respawn clear-point, carried as `resumeSessionId`, `session/load`
where advertised, fresh `session/new` otherwise).

## Problem

`providers.devin-acp.sessionRm` is rendered into
`bro acp-worker --session-rm 'devin rm {sessionId} --force'` — the worker
arms a detached retrier that deletes the devin session when the worker
exits. After that no resume is possible, so loop fix rounds and drive
fixers spawn cold third-party agents on the same worktree: each rebuilds
context from zero (re-reads the tree, digests the threads) while the
original session — which still holds the plan, the decisions and the
model's cache — has just been destroyed.

The directive: while the coder's devin session lives, a fix order must
land as a follow-up `session/prompt` turn in THAT session, in the SAME
worktree cwd (devin's sessions.db is cwd-keyed). Session deletion belongs
to PR settlement (merged or closed), not worker exit.

## Terms

- **resume id** — `AgentRegistryEntry.acpSessionId`, recorded by the acp
  driver after session open; the durable PR → branch → worktree →
  sessionId chain (the entry already records `worktree` + `provider`).
- **donor** — a registry entry on the fixer's target worktree whose
  recorded `acpSessionId` + acp-typed `provider` makes its session
  resumable by a different molStep (drive fixer resuming the coder's
  session).
- **settle** — the point a PR's registry sessions are deleted:
  `env.providers[e.provider].sessionRm` rendered per unique sessionId
  and run detached; `acpSessionId` cleared on the matched entries.

## Design

### 1. Worker-exit cleanup is gone

`--session-rm` leaves the acp-worker argv surface entirely:
`acpWorkerArgv` no longer renders it, `runAcpWorkerCommand` no longer
parses it, `AcpWorkerSpec.sessionRm` and `armSessionCleanup` are removed.
A worker exit now leaves the devin session live in the agent CLI's own
store. `providers.<name>.sessionRm` remains valid config — its consumer
moves to PR settlement (§5).

### 2. `bro acp-worker --resume <sessionId>`

New flag → `AcpWorkerSpec.resumeSessionId`. Session open becomes a
ladder after `initialize`:

- `agentCapabilities.loadSession === true` → `session/load
  {sessionId, cwd, mcpServers: []}`; else
- `agentCapabilities.sessionCapabilities.resume` present →
  `session/resume` same params; else
- log `session <id> not resumable — no load/resume capability; starting
  a fresh session` → `session/new`.

A successful load/resume attaches the SDK's update router to the
reopened session — `ClientContext.attachSession` exists at runtime but
is type-private, so the driver calls it through a narrow cast seam with
a fabricated `NewSessionResponse` (`{sessionId, modes, configOptions}` —
the load response omits `sessionId` because it equals the request's).
On success: log exactly `resumes session <id>` and
`spec.record({acpSessionId: <id>})` — the registry keeps the SAME id,
which is the acceptance invariant. A thrown load/resume (gone session,
old PR, fresh machine) logs `session <id> resume failed — <err>;
starting a fresh session` and falls back to `session/new`. The
model-pin, prompt-file and `pumpTurn` pipeline below is unchanged — the
fix order arrives as a `session/prompt` turn on whichever session
opened.

### 3. `resumeSessionId` through the spawn pipeline

`StepSpawnRequest.resumeSessionId` → `SpawnSpec.resumeSessionId` →
`prepareSpawn`. Inside prepareSpawn (the registry's clear-point, spec
bro-1x7p) the effective resume id is:

```
spec.resumeSessionId
  ?? (existing.provider === spec.provider && spec.provider !== undefined
      ? existing.acpSessionId : undefined)
```

The auto-lift covers same-bead respawns (loop fix rounds, drive fixer
re-spawns) for free; provider scoping means a lane change never feeds a
foreign provider a meaningless id. prepareSpawn returns it beside
`agentId`/`promptFile`; every argv-worker backend (native, tmux, docker
via `workerRunLine`, gascity if it renders argv) splices
`--resume <id>` before the promptFile positional. Template workers never
see it — `--resume` is an acp-driver flag.

### 4. Consumers

**Loop fix round** (`runFixRound` → `spawnWorker` → `conn.spawn`):
auto-lift; `spawnWorker` also passes the id explicitly for clarity. The
legacy `spawnAgent` path splices `--resume` into its argv exec the same
way when the dying entry + lane allow it. `buildFixPrompt` gains a
session note: resume armed → the order continues the live session; no
recorded session → the cold-start note ("the original coder's session is
gone — rebuild context from the worktree and the list").

**Drive fixers** (`spawnFixerAgent` — the one funnel for the
threads/rebase/ci/sast classes): under the occupancy locks, resolve the
donor — the fixer bead's own entry first, then any registry entry whose
recorded `worktree` resolves to the fixer's, carrying `acpSessionId` and
a configured `type:'acp'` provider. Donor found → the spawn request
pins `provider: donor.provider` (the id only loads on its minting
provider — the directive's "never a fresh third-party fixer while the
session lives") and `resumeSessionId: donor.acpSessionId`, and the work
order gets a `Session:` trailer naming the resumed session. No donor →
the existing cold fixer unchanged except the fallback note in the order.

### 5. `devin rm` at PR settlement

`settleAcpSessions(dir, env, {worktree?, molSteps?})` in
agent-connectors.ts: registry entries matching the settled worktree
(path-resolved) or named molSteps; per unique `acpSessionId` whose
entry's provider is a configured acp provider carrying `sessionRm`,
render the template ({sessionId} substituted; slug-checked) and run it
detached (`/bin/sh -c` — operator config, same trust contract the old
arm had). Matched entries' `acpSessionId` clears — the PR is done; a
stale id would only masquerade as resumable context. Returns the
settled ids for the caller's log line; failures are advisory, never a
settle blocker.

Call sites:

- **loop** `finalizeMerge`: MERGED → `{worktree: item.worktreeDir}`;
  merge-report CLOSED → the same settle before the park (the PR settled
  without merging; a still-OPEN park keeps the session alive).
- **drive** `mergeAndRetire` (MERGED), `drivePr`'s non-OPEN branch
  (`{worktree: work.worktreeByBranch.get(state.headRef)}` + the fixer
  bead's molStep), and `sweepSettledFixers` (`{molSteps: [row.id],
  worktree: <the fixer entry's recorded worktree>}`).

### 6. What does NOT change

`agents.json` needs no new fields — `acpSessionId`/`provider`/`worktree`
already carry the chain. `sessionRm` stays valid provider config with
new settlement semantics. Worker liveness, the `.exit` record, the bus
archive, and the occupancy/dedup planes are untouched. The fresh-fixer
fallback is total: every resume failure mode lands on today's cold path.

## Plan

- [ ] spec (this file)
- [ ] providers: `AcpWorkerSpec.resumeSessionId`, the load/resume ladder
  + `attachSession` seam, drop `sessionRm`/`armSessionCleanup`;
  `acpWorkerArgv` drops `--session-rm`; `--resume` flag on
  `bro acp-worker`
- [ ] spawn pipeline: `resumeSessionId` on StepSpawnRequest/SpawnSpec/
  serve body; prepareSpawn lift + return; argv splice in
  native/tmux/docker backends (`workerWithResume` helper)
- [ ] loop: runFixRound resume note + explicit resumeSessionId; legacy
  spawnAgent argv splice; settleAcpSessions on MERGED/CLOSED
- [ ] drive: donor lookup in spawnFixerAgent (provider pin +
  resumeSessionId + Session trailer); settleAcpSessions on
  mergeAndRetire / non-OPEN / sweepSettledFixers
- [ ] tests: argv render, resume ladder (load ok / no capability /
  load failure), same-id record, settlement render+clear, donor
  selection, drive "resumes session <id>" log
- [ ] `npm run build`, `npm run typecheck`, `npm test`; commit, push,
  PR
