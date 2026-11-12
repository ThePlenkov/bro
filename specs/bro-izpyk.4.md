# bro-izpyk.4 — fleet F4: `bro msg`, `bro task give`, `bro sessions resume`, interrupted list in `bro fleet resume`

Governing spec: `specs/sessions/bro-izpyk.md` (branch
`devin/1792972271-fleet-spec`), sections "Messages and tasks" and "Sessions
and resume". Builds on F1 (`specs/bro-izpyk.1.*`, ledger + `bro sessions` +
`bro fleet hosts`), F2 (`specs/bro-izpyk.2.md`, modes + the Tier-0 inbox
wake) and F3 (`specs/bro-izpyk.3.md`, claims — **not a dependency**: nothing
here touches `facade('claims')`; `bro task give` composes the tasks facade
only, so this lands cleanly ahead of PR #1032).

## What already exists (audit-verified on main)

- `bro notify --to <agentId|sessionId|orchestrator> --kind …` publishes one
  event through `facade('events')` → the mailbox transport drops a file
  into `<git-common>/bro/notify/` (or the XDG fallback); the notify
  connector's postTool/sessionStart probes drain it into session context.
  `--to` addressing already honors agentId, sessionId and the
  `orchestrator` role (`addressedTo` in `core/notify.ts`).
- F2 wired the Tier-0 half of the spec's inbox leg: `hooks/run.sh` computes
  `$XDG_STATE_HOME/bro/inbox/<host>-<sid>` (`inboxPath()` in
  `core/modes.ts`) and wakes Node when it is non-empty — "delivery itself
  lands with bro-izpyk.4". Nothing writes or drains that file today.
- `bro sessions` derives `interrupted` at read time
  (`deriveSessionState`: stored `live` + `lastSeen` older than this boot).
  `bro fleet resume` (`commands/resume.ts`) covers
  sweep/watch/daemon/loop/agents/worktrees only.
- `SessionPlane` (`core/session-planes.ts`) has `countLive`/`listLive`/
  `countWorkers` — no `resumeArgv`. Registered planes today: `devin`
  (`@broject/devin`) and `copilot` (`cli/session-planes/copilot.ts`); both
  are spawn-quota planes.

## Design

### 1. `bro msg <session|role> <text>` — new plugin, group `comms`

The spec's command is the addressed, session-keyed spelling of `bro
notify`. It is **not** an alias: `notify` addresses the mailbox
(agentId | sessionId | `orchestrator`); `msg` addresses the *fleet* —
ledger session keys and roles — and delivers through the spec's inbox leg
so it works on any host in any mode, ledger row or not.

**Target grammar** (first positional; the rest is the message text,
`--` escapes option-looking words, strict flag parsing like notify):

| target | resolution |
| --- | --- |
| `<host>:<sid>` | exact `SessionKey` — ledger row required |
| `<sid>` | ledger match: exact sid, else unique sid-prefix (≥4 chars); zero matches → mailbox address fallback |
| `<agentId>` | ledger rows with `spawnedBy === agentId`; zero matches → mailbox `to: <agentId>` |
| `orchestrator` | the role — ledger rows with `spawnedBy` null; zero matches → mailbox `to: orchestrator` |

Ambiguous prefix/multi-match → usage error listing candidates, never a
guess. `ended` sessions are skipped and reported (their hooks never fire
again; a stale inbox file would sit forever — inbox entries have no TTL).

**Delivery — two channels, one message, never two copies in one context:**

1. *Inbox leg* (spec's "worker renders the message into the recipient's
   inbox file; Tier 0 delivers it on that session's next hook"). There is
   no resident worker — F1 chose drain-on-read — so `bro msg` itself plays
   the worker's role: for every resolved session whose host is
   inbox-capable it appends one JSONL entry to
   `inbox/<host>-<sid>` via `appendSessionInbox` (new core helper next to
   `inboxPath` in `core/modes.ts` — `O_APPEND`, one line per entry:
   `{ts, from, kind, text}`). run.sh's `[ -s ]` check wakes Node on the
   session's next hook in **every** mode.
2. *Events leg* — `facade('events').publish({topic:'msg', kind, to, …})`
   for the bus/record plane, exactly like notify. The `to` value is chosen
   so the default mailbox transport never double-delivers:
   - inbox-delivered session → `to: '<host>:<sid>'` (the session key —
     `addressedTo` cannot match it, so the drop is a pending record that
     expires on TTL; bus subscribers and `peekMailbox` still see it);
   - unresolved/`unknown`-host/orchestrator-fallback → `to:` the mailbox
     vocabulary (`sid`, `agentId`, `orchestrator`) so wired sessions still
     receive it the notify way.

   Inbox-capable hosts are the four `hookHostOf` answers that are not
   `unknown` — `claude`, `codex`, `cursor`, `devin` — the same set run.sh
   can name a mode/inbox file for. A ledger row on any other host
   (including `unknown`, which is where plugin-host sessions land when
   they do spool) publishes `to: <sid>` instead: the mailbox drain matches
   on raw `session_id` regardless of host, so delivery still lands.

3. *Inbox drain* — the notify connector's existing postTool/sessionStart
   probe gains a second source: `drainSessionInbox(ctx)` reads and
   atomically claims `inbox/<host>-<sid>` (rename to a `.drain-*` sibling,
   parse JSONL, render `[msg <from>] <text>` lines, unlink the claim —
   new appends recreate the path, so a mid-drain publish is never lost).
   `ConnectorCtx` gains optional `host?: string`; `hookCtx` stamps
   `hookHost` (already resolved per event for mode binding). Host
   `unknown`/absent or sid empty → no inbox read (those sessions are
   served by the mailbox `to: sid` path). The drain is inside the same
   probe, so observe-mode sessions get it too — notify is `activeIn:
   all`.

`--kind` accepts the notify vocabulary (`note|info|ask|result|block`,
default `note`); `--in-reply-to`/`--key` ride the events publish like
notify's. `bro msg` prints the publish locator when the transport has
one, plus one line per inbox file written — the honest delivery report.

### 2. `bro task give <session|role> <title…>` — verb on the `task` doc type

`task` is a reserved doc noun (a `task` plugin would shadow `bro task
list|show|…`), so `give` lands as a **custom verb on `taskDoc`'s adapter**
(`doctypes/task.ts`) — `bro task give` is noun-first dispatch, no new
command surface. It reuses the shared session-msg module:

1. resolve `<session|role>` with the same resolver `bro msg` uses;
2. `store.create({title})` through `facade('tasks')` — the store the doc
   type already fronts (`connectors.tasks` pin honored);
3. assign through the same facade: `store.update(id, {assignee})` where
   assignee is the session's fleet address — `spawnedBy` (agentId) when
   the row carries one, else `<host>:<sid>`, else the raw target for a
   role/unresolved address. Status is left alone: assignment is a
   marker, `claim()` would bind the *caller's* actor, not the target;
4. send the message through the `bro msg` path —
   `task <id> assigned: <title>` with `--in-reply-to <id>` semantics
   (`cause` on the event, `key: 'task-<id>'` so repeat gives coalesce).

`--global` scope keeps working through the doc layer (the user-level
store gets the bead; the message still targets the session).

### 3. `bro sessions resume <id|--last|--pick>` — subcommand of `sessions`

`SessionPlane` gains the spec's optional member:

```ts
resumeArgv?(nativeSessionId: string, cwd: string): string[] | null
```

`null`/absent = the host has no resume command bro knows — the command
reports that instead of guessing (epic spec). `cwd` is the session's own
working directory: every supported host scopes resume to where the
session ran.

**Planes.** `devin`'s existing plane (`@broject/devin`) gains
`resumeArgv: sid => ['devin', '--resume', sid]`. A new
`cli/session-planes/resume.ts` registers minimal planes for the other
manifest hosts — `kind` = the ledger host string, `detectsCli: () =>
false`, `startsSessions` absent, `countLive` throws
`SpawnError('unavailable')` (never reached: quota paths only see planes
that claim a command or an armed `agents.<kind>` quota, and a declared
`sessionKind` pointing here fails closed, which is the honest answer for
a kind with no countable sessions). Verified argv per host docs:

| host | resumeArgv |
| --- | --- |
| claude | `claude --resume <sid>` |
| codex | `codex resume <sid>` |
| opencode | `opencode --session <sid>` |
| cursor | `agent --resume <sid>` (cursor's CLI binary; `cursor-agent` is the legacy alias) |
| devin | `devin --resume <sid>` |
| kilo, pi, omp, unknown, … | none — reported unsupported |

`sessions.ts` imports the resume-planes module (and `@broject/devin` for
its plane) so the registry is populated on the read path.

**Resolution.** `<id>` accepts `host:sid`, a bare sid (exact, then
unique-prefix), or an agentId (`spawnedBy`) — same candidate rules as
`bro msg`, ambiguity errors with the candidate list. `--last` picks the
most recently seen session (the `bro sessions` ordering — any state;
the printed/spawned line names the state so a live session is never a
surprise). `--pick` lists sessions newest-first with a number and reads
one line from stdin; non-TTY stdin is a usage error, not a hang.

**Execution.** Default: spawn the argv with `stdio: 'inherit'` and
`cwd: row.cwd ?? process.cwd()` — resume is an interactive act, the
operator's terminal owns it. `--print` renders the argv instead (tests,
scripts, unsupported-host previews). A host with no `resumeArgv` (or no
plane) prints `host '<h>' has no resume command` plus the session row —
exit 0, it is a report not a failure; a resolved session whose plane
throws is an error exit.

### 4. Interrupted list in `bro fleet resume`

`resumePass` gains a `sessions` leg, report-only per the epic spec
("launching them into tmux or herdr is a later launcher facade and out
of scope"):

- `collectSessionViews`-equivalent read: `facade('ledger').sessions()`
  machine-wide (a restart interrupts every project, not just this
  repo's), `deriveSessionState` per row, keep `interrupted` only —
  sorted lastSeen desc, capped at 10 rows with a `…and N more` tail.
- Each row renders `host sid-prefix cwd-age resume-cmd` where
  resume-cmd is the joined `resumeArgv` or `unsupported` — the same
  plane lookup `bro sessions resume` uses, so the two surfaces can never
  disagree.
- `ResumeReport.sessions = { interrupted: Row[], truncated?: number,
  warnings: string[] }` — additive JSON field; the text pass prints a
  `resume: sessions — N interrupted …` block with per-session lines and
  `bro sessions resume <host>:<sid>` as the actionable hint (the argv
  itself stays available via `--print`).
- Ledger unreadable → a warning line, never a failed pass: the
  supervisor legs must not die on an optional read surface.

## Testing

- `session-inbox` unit tests: append→claim round-trip, JSONL parse,
  foreign-line passthrough, claim-race safety (append during drain
  survives), `unknown`/empty sid → null path.
- `msg` resolution tests: key/sid/prefix/agentId/orchestrator, ambiguity,
  ended-skip, unknown-host `to: sid` publish rule, zero-match mailbox
  fallback — against an injected ledger + a stub events facade.
- `task give`: create+assign+message composition on a fixture store.
- `sessions resume`: argv table per host, id/--last/--pick resolution,
  `--print` output, unsupported host report — injected planes/ledger.
- `fleet resume`: interrupted derivation + resume-cmd column + JSON shape.
- ConnectorCtx `host` plumbing: hookCtx stamps hookHost; notify drain
  delivers an inbox file end-to-end (fixture inbox + ctx).

## Non-goals / deferred

- No `bro fleet worker` — inbox writes happen inline in `bro msg`;
  worker-rendered inbox files arrive when a resident writer exists.
- No launcher facade (tmux/herdr spawn of resumed sessions) — F5.
- `history()` backfill, remote ledger — F5.
- `task:*` claim delegation — F3's ClaimFacade (PR #1032); `give`
  assigns through the tasks facade only.
- No mode-file/inbox GC — inbox claims self-clean on drain; orphaned
  files for dead sessions are janitor territory later.
