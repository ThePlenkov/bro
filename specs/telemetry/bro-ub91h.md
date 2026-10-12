---
parent: bro-ub91h
scope:
  - packages/core/src/lifecycle.ts
  - packages/core/src/lifecycle.test.ts
  - packages/core/src/index.ts
  - packages/core/src/planes.ts
  - packages/core/src/janitor.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/next.ts
  - packages/cli/src/commands/work.ts
  - packages/cli/src/commands/act.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/planes/events.ts
  - packages/cli/src/planes/events.test.ts
  - specs/telemetry/bro-ub91h.md
---

# bro-ub91h — rig lifecycle event log: one ordered JSONL the planes read

Parent: `bro-9rls` (planes epic) — events is a plane.

## Problem

The substrate exists but is fragmented: `act-checks.jsonl` (gate
snapshots), `hooks/perf/*.jsonl` (hook timings per session),
`agents/*.exit` (codes), `judge/verdicts.jsonl`, mailbox drops, watch
markers. Each answers its own narrow question; none composes into a
bead→land timeline. Cycle time, review latency, fix rounds, and
WIP-over-time are unanswerable today — the data the adaptive-cap bead
needs to tune itself does not exist in one place.

The bus is not the answer either: `core/bus.ts` is an in-memory ring —
ordering survives only while a broker process lives, and nothing is
durable across restarts.

## Design

### The journal — `<git-common>/bro/events.jsonl`

One append-only JSONL per rig under the shared git common dir, so a
claim in one linked worktree and the merge in another land in the same
ordered file. Append order is the order: `emitLifecycle` serializes
writers on the file's own lock (`withFileLock`, same as every sibling
journal), so line position is the sequence — no `seq` field needed.

Row schema — small, stable, grep-able:

```ts
{ ts, kind, bead?, pr?, actor, session, from?, to?, detail? }
```

- `ts` — ISO-8601 transition time. Stamped by the emitter; a caller
  with the honest clock (e.g. an `.exit` file's mtime) may pass it.
- `kind` — the transition verb: `claim`, `worktree`, `spawn`,
  `agent-exit`, `pr-open`, `gate`, `verdict`, `merge`, `park`,
  `release`, `close`. A union for writers; readers treat kind as an
  open string so future kinds never break the plane.
- `bead` — the bead id when the transition binds to one; `pr` — the
  PR number when it binds to a pull request. Both optional; a
  lifecycle row is allowed to name either or both.
- `actor` — the doer: a worker's `BRO_AGENT_ID` when it has one, else
  `bdActor(dir)` (the claim-assignee identity). Callers pass an
  explicit actor only when recording a transition on another's behalf
  (an agent exit row's actor is the dead worker, not the harvester).
- `session` — `BRO_SESSION_ID` → `DEVIN_SESSION_ID` →
  `CLAUDE_SESSION_ID` → `CODEX_SESSION_ID` → `OPENCODE_SESSION_ID`
  (same chain `bro goal` resolves), else the literal `'shell'` — a
  sessionless CLI invocation is its own session.
- `from`/`to` — the state edge (`open`→`in_progress`,
  `running`→`exited`, →`merged`); `detail` — flat JSON extras
  (`agent`, `code`, `cause`, `round`, `sha`, `blockers`, `threads`,
  `worktree`, `branch`, `via`). `via` names the writing surface —
  `loop`, `act`, `drive`, `agents`, `work`, `next`, `convoy` — the
  writers the bead enumerates.

### The one helper — `emitLifecycle` / `readLifecycle` in `@broject/core`

`packages/core/src/lifecycle.ts` — core because both the writers'
packages (cli commands, `@broject/act`'s watch machinery) and the
readers (cli planes) can already import it, and it owns the pieces the
helper composes (`gitCommonDir`, `withFileLock`, `bdActor`).

- **fail-open** — a null git common dir, an unwritable file, a lock
  timeout: telemetry never throws into the command it observes. A lock
  timeout degrades to an unlocked append (same rule as
  `appendJournal`), never a stall.
- **self-capping** — append + cap-check + compact inside the same
  locked section, same discipline as `act-checks.jsonl` (which the
  janitor comment already calls self-capping): over 4 MiB, truncate to
  the newest whole lines under 2 MiB. The derived views are windowed
  anyway; a wedged writer must not grow the file forever. Not in the
  janitor's cap list — its 1 MiB bound would fight the 4 MiB policy.
- `readLifecycle(dir, {limit, kind, bead, pr, since})` — ordered read
  (file order), torn/malformed lines skipped not fatal, `limit`
  returns the newest rows.

### Writers — every transition, one helper

| kind | site | edge |
| --- | --- | --- |
| `claim` | `prepareSpawn` (registry claimStep/rebindStep — covers loop, convoy, drive fixers, `agents up`), `claimUpTo` (`bro next` + loop clump members), `claimBead` (`work enter`) | open→in_progress, in_progress→in_progress (rebind) |
| `worktree` | `finishWorktreeEnter` (`work enter` + `stack push`), `planItemAndWorktree` (loop, fresh only), `ensureFixerWorktree` (drive, created only), `cmdLeave` + `removeMergedWorktree` (shared merge/sweep cleanup) + `retireIfOrphaned` (drive) | →created / →reused / →removed, detail `{worktree, branch, base?, via}` |
| `spawn` | `prepareSpawn` — every backend's registry spawn | →spawned, detail `{agent, backend, provider?, model?}` |
| `agent-exit` | `ensureExitCause` — the once-per-run harvest that folds `.exit` + classified cause into the registry | running→exited / →blocked, detail `{agent, code, cause}`, ts = exit-file mtime, actor = agentId |
| `pr-open` | the loop's `findPr` discovery — the member-join arm and the serial spawn's member create, both after the worker exits with a PR on the branch | →open, detail `{branch, agent?}` |
| `gate` | `serviceGate` memberAction (loop's settled gate decisions per head — `wait` polls record nothing), `cmdWait` settle (one row per wait: green/blocked/timeout/externally-settled + the update-branch step) | →green / →blocked / →parked / →behind / →updated / →timeout / →closed, detail `{action, round?, sha, open_threads, blockers?}` |
| `verdict` | `disposition()` — the single choke every thread verdict already funnels through (resolve/reply/defer/bulk), plus `cmdResolve --unresolve` | →fixed / →rejected / →deferred / →replied / →unresolved, detail `{thread}` |
| `merge` | `landPr` — every bro merge funnels through `act merge` (loop + drive included); `finalizeMerge`'s `alreadyMerged` arm re-probes `MERGED` before recording landings observed externally | →merged / →enqueued, detail `{sha, method?, queue?}` |
| `park` | `leave()` on a `'parked'` verdict + the done-path parked results that bypass `leave` | →parked |
| `release` | `reopenBead` (the loop's single unclaim choke), `dischargeLandedId`'s uncovered-member re-queue (act) | in_progress→open |
| `close` | `closeLanded` (loop's settleClump) + `agentVerdict` per closed bead, `dischargeLandedId` (act), `closeFixer` (drive) | →closed |

Emit AFTER the transition lands — a failed claim, a refused merge, a
worktree add that errors record nothing.

### The read plane — `events.lifecycle` + tail merge

`LifecycleRow` joins the row vocabulary in `core/planes.ts`
(`origin: 'lifecycle'`, `id: 'life:<n>'` — the line index; compaction
shifts ids the same way truncation flags `gapped`).

The events plane gains a `lifecycle` named read — args
`{limit, kind, bead, pr, since}` returning `{events, gapped, reason?}`
— generated onto REST (`GET /events/lifecycle`) and MCP
(`bro_events_lifecycle`) like every declared read. `since` is an ISO
timestamp there (unlike `tail`'s bus-seq cursor). `tail` merges
`LifecycleRow`s into the same ts-sorted stream it already serves, so
a dashboard reads one ordered feed: bus live events, mailbox drops,
and the durable timeline. `capabilities.read` counts the journal as
a source.

Derived views the data now answers (first consumers named in the
bead): cycle-time per bead (claim→merge/close), landed/day (merge,
close), gate-service latency (pr-open→green), fix-rounds per PR
(gate→blocked `round`), worker wall-time (spawn→agent-exit), WIP
curve (claim vs release/close rate).

## What it is not

- Not a bus replacement — the bus is the live pub/sub; this is the
  durable journal. Both feed `events tail`.
- Not per-event dedup at write time — `pr-open` rows on every watch
  arm are honest observations; consumers take first-per-pr.
- Not a metrics engine — derived views are readers over the journal.
