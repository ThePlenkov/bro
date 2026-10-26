---
parent: sessions
status: draft — for alignment, not yet a bead
---

# bro-izpyk — fleet: one ledger for every agent session on the machine

## Problem

bro is wired into the hooks of many host agents (Claude, Codex, Cursor, Devin, opencode, pi,
kilo, omp, …), but nobody can tell where it works, where it fails, or what is running.
The audit (`specs/sessions/bro-36sx7.md`) shows the cost of the current design: **every** host
session pays for bro's full hook pipeline — Node start, git, bd, gh, locks — whether or not the
operator wants bro to do anything in that session. The result is hosts that freeze, `Command timed
out after 10s`, and no record of any of it.

Coordination primitives exist today, but only for agents that **bro spawned**: the agent
registry, `BRO_AGENT_ID`, the occupancy plane, and the mailbox. Interactive sessions the operator
starts by hand are invisible except through arming markers. After a reboot, the operator cannot
answer "which agent was working in this folder, and how do I get it back?"

## Positioning (prior art, checked)

- **herdr** (herdr.dev) owns the terminals. It is a background server with panes. It detects
  agents in its panes, shows working/blocked/idle, resumes sessions after a restart, and lets
  agents prompt each other over its socket. All of that works **only inside herdr**, and the
  host coverage is whatever herdr recognizes.
- **Session browsers** such as sesh, saisons, showagent, omnisession, cli-continues and agf read
  each host's native store **after the fact** (`~/.claude/projects`, `~/.codex/sessions`,
  opencode's SQLite, …). They list sessions and resume or transfer them. They have no live
  coordination: no claims, no messaging, no modes.
- **beads** owns claims, leases, heartbeat/reclaim, gates, merge-slot and delegated mail. These
  are task-level and per-store, not session-level.
- **gascity / gastown** orchestrate the agents **they** spawn.

So `bro sessions` (list everything in this folder) is **not new on its own**; sesh and saisons
already do it. The new thing is the combination:

- the agent's own hooks give a **live** view;
- it does not depend on which terminal launched the agent;
- every session, including interactive ones, gets the same claims, inbox and tasks;
- behaviour is gated per session by a **mode**;
- every backend sits behind a facade.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **host** | An agent product (claude, codex, devin, …), represented in bro by a host adapter. |
| **session** | One host conversation: `(host, nativeSessionId)`, plus cwd, pid/start-time, adapter version, mode, and state (live, idle, ended, interrupted). |
| **project** | Identity = realpath of the git common dir (or of the folder when there is no git), plus a remote hash. Linked worktrees fold into one project. |
| **fleet** | All sessions of one project on this machine. The machine fleet is the union of all projects. |
| **mode** | A per-session behaviour switch: `observe` (implicit default), `plan`, `code`, `review`, `orchestrate`. |
| **claim** | A session's lease on a resource URI (`worktree:`, `branch:`, `task:`, `pr:`, `path:`, `role:`). |
| **ledger** | The machine-wide store of installs, sessions, hook events, claims and modes. |

## Core rule: facades only

The core (`@broject/core`) knows contracts, never backends. This spec adds two facades to
`FacadeMap` and extends one registry. Everything else reuses facades that already exist:

| Concern | Contract | Default backend | Swappable for |
| --- | --- | --- | --- |
| hook/event/session storage | **`ledger: LedgerFacade`** (new) | spool + `node:sqlite` (WAL) under `$XDG_STATE_HOME/bro/` | jsonl-only, OTLP sink, remote ledger (mesh, later) |
| resource leases | **`claims: ClaimFacade`** (new) | ledger-sqlite leases | beads (`bd update --claim`) for `task:*`, mesh for cross-host |
| host specifics | **`SessionPlane`** (extended, optional members) | one plane per host | — (vendor names never reach core) |
| messages between sessions | `events: EventsFacade` (exists) | mailbox transport | bus, MQTT, … |
| tasks given to sessions | `tasks: TaskStore` (exists) | beads | linear, jira, … |

```ts
// core/src/ledger.ts
export interface LedgerFacade {
  append(rows: LedgerRow[]): Promise<void>          // worker-side batch insert
  sessions(q: SessionQuery): Promise<SessionRow[]>  // bro sessions
  installs(): Promise<InstallRow[]>                 // where bro is wired + firing
  stats(q: StatsQuery): Promise<HookStat[]>         // p50/p95, timeouts, errors per host×event
  setMode(s: SessionKey, mode: Mode): Promise<void>
}

// core/src/claims.ts
export interface ClaimFacade {
  claim(r: ResourceUri, s: SessionKey, o?: { ttlMs?: number; exclusive?: boolean }): Promise<ClaimResult>
  release(r: ResourceUri, s: SessionKey): Promise<void>
  list(q: { project?: string; session?: SessionKey; resource?: string }): Promise<ClaimRow[]>
}

// SessionPlane gains optional host-adapter members
interface SessionPlane {
  // …existing countLive/listLive…
  detectHook?(env: NodeJS.ProcessEnv): boolean               // is this hook invocation mine?
  normalizeHook?(payload: unknown): CanonicalHookEvent       // session id, event, tool, cwd
  resumeArgv?(nativeSessionId: string, cwd: string): string[] | null
  history?(since: Date): AsyncIterable<SessionRow>           // optional backfill from native store
}
```

The hot path (`hooks/run.sh`) does not use any facade. It writes the spool format, which is a
versioned wire contract. Only the worker and the read commands go through `LedgerFacade`. That is
why the database can be swapped without touching the hooks.

## Hook pipeline: tiers and budgets

### Tier 0: every session, always (shell only, no Node)

`run.sh` does three things:

1. **Append one line** to the spool (`O_APPEND`, ≤ 4 KB, no lock). The line holds: spool format
   version, ts, host, native session id, event, cwd, pid/ppid, adapter version, launcher, and the
   phase `start`.
2. **Check two files:** `sessions/<host>-<sid>.mode` and `inbox/<host>-<sid>`. These are plain
   `[ -s ]` tests.
3. **Exit or continue.** With no mode (observe) and an empty inbox, exit 0. When the inbox has
   items, emit them as context, which is a `cat` of a file the worker pre-rendered. In both cases,
   append an `end` line with the duration.

If a `start` line has no matching `end`, the host killed the hook (a timeout). That is how host
timeouts become visible even though bro never sees them.

**Budget: p95 ≤ 15 ms**, with zero Node starts. This is the cost bro charges every agent it is
installed into.

### Tier 1: a mode is active

The answer path reads the snapshot for this mode (`snapshots/<project>/<mode>/<event>.txt`,
pre-rendered by the worker) and emits it. Node starts **only** for events that need a live
decision, and only in the modes that declare that need:

- `permission` / `pre-tool` with guard enabled for the mode;
- `stop` while the session holds an armed claim.

Hard watchdog in `run.sh`: kill and exit 0 after 2 s (5 s for `stop`). bro never reaches the
host's timeout.

| event | observe | mode active, answer from snapshot | mode active, live decision |
|---|---|---|---|
| post-tool, prompt-submit | ≤ 15 ms | ≤ 30 ms | — (never live) |
| session-start, compaction | ≤ 15 ms | ≤ 50 ms | — |
| permission, pre-tool | ≤ 15 ms | — | ≤ 300 ms |
| stop | ≤ 15 ms | ≤ 50 ms | ≤ 3 s, armed only |

### Worker: lazy, single writer, exits when idle

Tier 0 starts `bro fleet worker` detached when no live worker exists (pid file plus
`flock -n`/tryLock, never a wait). The worker:

- drains the spool into the ledger in batches;
- binds modes, claims and heartbeats from the events;
- runs the heavy connector probes asynchronously, per (project, mode);
- re-renders the snapshots and inbox files;
- exits after 60 s without events.

There is one writer, so the hook path needs no locks. The worker's version is that of the CLI
that spawned it. The spool and snapshot formats are versioned, and unknown versions are skipped.

`npx` and the `bro hooks </dev/null` probe leave the hook path entirely. When no CLI is found,
Tier 0 writes an `outcome=no-cli` line, and the session-start inbox carries an install hint.

## Modes

- **observe** (implicit default): Tier 0 only. The session is visible in `bro sessions`, gets
  inbox delivery, and can hold claims through explicit CLI calls. There are no gates, no
  rehydration and no guard.
- **plan**: context = ready tasks, specs and the open plan. The stop gate checks that the plan is
  recorded.
- **code**: today's arming behaviour (work, task and drill gates), guard and claim enforcement.
- **review**: the act gate, threads and PR context.
- **orchestrate**: exclusive per project, implemented as an exclusive claim on
  `role:orchestrator@<project>`. Context = the fleet board plus worker mail. Gets the supervisor
  duties (drive, resume, convoy dispatch). This replaces the current heuristic
  `isOrchestratorSession() := no BRO_AGENT_ID`.

**Activation** happens through `bro mode <name|off>` (also as the skill `/bro mode …`), run from
the agent's own shell tool. The CLI cannot know its host session id on every host. Instead, the
**post-tool hook binds it**: the payload carries both `tool_input.command` and `session_id`. Tier 0
sees `bro mode` in the command and the worker writes the mode file. This is the same mechanism
arming already uses. A host whose adapter exports a session env var can also bind directly.

**Plugins declare their modes.** A connector states `activeIn: Mode[]` per hook (for example act:
`['review', 'orchestrate']`). The hook dispatcher runs only the connectors active in the session's
mode. A project can set a default mode in `bro.config.json` (`modes.default`). The global default
stays `observe`.

## Sessions and resume

- `bro sessions [--project|--all] [--host h] [--live] [--json]` lists rows from the ledger: host,
  id, project/branch, mode, state, last activity, claims and the resume command. A session is
  `interrupted` when its last event is older than the boot time and it never sent an `end`/stop.
- `bro sessions resume <id|--last|--pick>` runs `plane.resumeArgv()`: `claude --resume <id>`,
  `codex resume <id>`, `opencode --session <id>`, and others per adapter. A host with no
  resume command reports that instead of guessing.
- `bro fleet resume` (today's post-restart pass for bro's own supervisors) gains a section that
  lists interrupted sessions together with their resume commands. Launching them into tmux or
  herdr is a later launcher facade and out of scope here.
- `plane.history()` backfills sessions from before bro was installed. This is optional and
  lowest priority, since sesh and saisons already cover it.

## Claims and conflicts

Resource URIs: `worktree:<path>`, `branch:<name>`, `task:<id>`, `pr:<n>`, `path:<glob>`,
`role:<name>@<project>`.

- **Leases and heartbeat.** Any hook event from the holder renews its leases. A lease is released
  when the session ends, or when its TTL expires and the pid is dead.
- **`task:*`** delegates to the tasks facade (the bd claim stays the source of truth).
  Everything else lives in the ledger backend.
- **Conflict policy by mode.** In observe, a conflict is shown as an inbox note. In code, guard
  warns on pre-tool, and blocks only when the project config opts in.
- **Migration.** Today's arming markers (`<git-common>/bro/hooks/*.armed`) and the
  occupancy entries in `agents.json` become claims. Bro-spawned agents (`BRO_AGENT_ID`) are
  sessions with a `spawnedBy` field.

## Messages and tasks

- `bro msg <session|role> <text>` publishes to `events` with `to` set to a session key or a role.
  The worker renders the message into the recipient's inbox file, and Tier 0 delivers it on that
  session's next hook. This works on **any** host, in any mode.
- `bro task give <session|role> <title…>` creates and assigns the task through the tasks facade,
  then sends a message.

## Ledger (default backend)

`$XDG_STATE_HOME/bro/ledger.db` uses the built-in `node:sqlite` module with WAL mode. Verified:
Node 24.22, SQLite 3.53. No dependency is added. Tables:

- `installs(host, adapter_version, plugin_root, first_seen, last_seen)`
- `sessions(host, sid, project, cwd, branch, mode, state, pid, pid_start, started, last_seen, spawned_by)`
- `events(ts, host, sid, project, event, phase, ms, outcome, launcher, detail_json)`, with
  outcome one of `ok | fastpath | timeout | killed | error | no-cli`
- `claims(resource, host, sid, project, exclusive, lease_until)`
- `hook_stats_daily(day, host, event, n, p50, p95, timeouts, errors)`

Retention: 14 days of `events`, 180 days of daily stats. The worker runs a size check.

Rejected backends:

- **Dolt/beads**: the cold handshake takes 1.5–2 s (the repo's own figure).
- **DuckDB**: a large native binary built for OLAP.
- **LMDB / better-sqlite3**: native dependencies.

## Visibility

- `bro fleet board` / `bro status --fleet` shows hosts × installs: adapter version, last event,
  whether hooks fire, p95, timeouts and the last error. Below that, sessions per project.
- `bro doctor` reports:
  - **installed but silent**: an adapter is present but there have been no events for N days;
  - **firing but killed**: there are start lines without end lines;
  - **duplicate wiring**: two adapters fire for the same session and event, for example
    `.devin/hooks.v1.json` plus the plugin.

## Non-goals

- Owning terminals. That is herdr's job; at most, a launcher facade later.
- Moving a conversation from one host to another. That is omnisession's or showagent's job.
- Multi-machine fleets. The facade allows a remote ledger or claims backend later, through mesh.

## Phases (each is one shippable PR)

1. **F0, perf fixes (Epic A: bro-36sx7)** (from the audit): duplicate hooks, npx and the probe,
   lock waits, `gitCommonDir` memoization, async Kilo, watchdog.
2. **F1, ledger (bro-izpyk.1)**: `LedgerFacade`, the Tier 0 spool writer in `run.sh`, the lazy
   worker with sqlite, `bro sessions`, `bro fleet board`, and the doctor checks.
3. **F2, modes (bro-izpyk.2)**: `bro mode`, mode files, connector `activeIn`, a Tier 1
   snapshot renderer, and observe as the default. This is the change that removes the hook cost
   for sessions with no mode.
4. **F3, claims (bro-izpyk.3)**: `ClaimFacade`, migration of arming and occupancy, orchestrate
   exclusivity.
5. **F4, messages, tasks, resume (bro-izpyk.4)**: `bro msg`, `bro task give`,
   `bro sessions resume`, and the interrupted-session list in `fleet resume`.
6. **F5, optional (bro-izpyk.5)**: `history()` backfill, a launcher facade (tmux/herdr), and a
   remote ledger.

## Open questions

1. **One mode per session, or a set?** For example, `code + review` together. The draft proposes
   one mode, with `orchestrate` exclusive.
2. **Should observe sessions also get passive conflict notes** (another session claims this
   worktree)? That costs one extra file test in Tier 0.
3. **Prompt capture for session titles.** Store the first prompt (80 characters) for
   `bro sessions`, or only the cwd and branch? This is a privacy default.
4. **Ledger scope.** Machine-wide (proposed), or per project with a machine index?
5. **Resume commands for devin, cursor, kilo and omp.** These still need checking per host.
