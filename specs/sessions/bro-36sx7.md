# bro-36sx7 — hooks perf: no hook may stall its host agent

Static review of `main` @ `c08fe62`. No hooks were run. Line numbers are from that commit.
Severity:
- **S1**: can push a hook past the host timeout, so the agent freezes.
- **S2**: a steady cost on every event.
- **S3**: makes problems invisible or harder to see.

## S1: blocking that host timeouts expose

### 1. Synchronous lock wait blocks the event loop and disables every internal timeout (A1: bro-36sx7.1)
- `packages/core/src/filelock.ts:39-40`: `syncSleep = Atomics.wait(...)`.
- `filelock.ts:264-283`: `acquireFileLock` loops on `syncSleep(25)` until `waitMs`.
- `filelock.ts:24`: `LOCK_WAIT_MS = 20_000`.

While the wait runs, no `setTimeout` can fire. That defeats `probeWithTimeout`
(`core/src/connectors.ts:941-955`, `PROBE_TIMEOUT_MS = 4_000`; the comment there admits it: *"still a
blocking call no timer can preempt"*), `boundedMs` (`hooks.ts`), and the stop path's 4 s budget.

**Fix:** no lock in a hook process may wait. Pass `waitMs: 0` and fall back on failure. Add an
async `acquireFileLockAsync` (polling with `await setTimeout`) for the rare place that really has
to wait.

### 2. post-tool waits up to 20 s on the occupancy lock (A1: bro-36sx7.1)
- `packages/cli/src/commands/hooks.ts:709-714`: when the aspect is `work`, `armSession` calls
  `acquireFileLock(<common>/bro/agents.json.lock, { label: 'occupancy lock' })` with no
  `waitMs`, so the 20 s default applies.
- The registry holds this lock while it spawns (drive/loop/agents up).
- `armSession('work')` fires from `armPostTool` whenever the command matches
  `git worktree` / `bro work` / `bd worktree`.

Any of those commands run while a drive is active pushes post-tool past its 10 s timeout. The
catch branch's comment (*"held past the bound — write anyway"*) shows the lock is not even
required for correctness.

**Fix:** pass `waitMs: 0`. The arming marker is a pure file create (the comment at `:461` says
so), so the lock is optional.

### 3. Journal and learn locks on every post-tool, with synchronous waits (A1: bro-36sx7.1)
- `hooks.ts:919`: `journalTrace` → `withFileLock(trace.lock, …)` with waitMs 2 s.
- `hooks.ts:993-1006`: `appendJournal` → `withFileLock(path.lock, …)` with a default waitMs of
  2 s. It is called from `flushPerf` (`:1045-1055`) on every event.
- `packages/learn/src/connector.ts:357`: `withFileLock(fired.lock, …, { waitMs: 2_000 })`.

Parallel tool calls from one agent run parallel post-tool hooks that contend for the same files.
In the worst case that is about 6 s of frozen event loop per hook, and it compounds with #1.

**Fix:** append without a lock. Use `appendFileSync` with `O_APPEND`, one row ≤ 4 KB, which is
atomic in practice on local file systems. Alternatively, use per-process files merged on read.
Learn-fired: `waitMs: 0`; skipping the "fired" record on contention is harmless.

### 4. Synchronous git spawns on async probe paths (A2: bro-36sx7.2)
- `core/src/git.ts:27-45`: `git` and `gitTry` use `spawnSync`.
- `git.ts:67-80`: `gitCommonDir` does one spawn, plus a fallback spawn on git < 2.31.
- Callers on the hook path:
  - `learn/connector.ts:74`: rev-parse;
  - `learn/connector.ts:240,242,248`: show-toplevel, branch, `gitUpstreamBehind`;
  - `guard/src/probes.ts:100`: branch;
  - `guard/src/probes.ts:129`: **`status --porcelain -uall`**, which is O(files in the tree);
  - `act/src/pending-watch.ts:89`: `execFileSync git rev-parse` in `watchesDir`, reached from
    `act/connector.ts` stopGate/sessionStart through `hasLiveWatch`/`listWatches`.

These probes run "in parallel" through `Promise.all`, but each `spawnSync` serialises the whole
process and switches off the timers from #1. `guard/probes.ts:34` itself says to use the async
twins, yet lines 100 and 129 still call `gitTry`.

**Fix:** add `gitTryAsync` / `gitCommonDirAsync` in `core/git.ts` (the same pattern as `bdAsync`
and `ghAsync`). Move every probe path onto them. Run `status -uall` only in modes or events that
need it, or cache it by `.git/index` mtime.

### 5. The Kilo adapter blocks the host process (A3: bro-36sx7.3)
- `plugins/kilo/bro/bro.ts:58-63`: `runBroHook` → `spawnSync(…, { timeout: 20_000 })`.
- `plugins/kilo/bro/bro.ts:105-109`: tools → `spawnSync(…, { timeout: 120_000 })`.

This runs **inside Kilo's own process**, so the whole agent freezes for up to 20 s per event, or
120 s per tool. The opencode and pi adapters already use async `spawn` + `killAfter`
(`opencode/bro/bro.ts:333-363`, `pi/bro/bro.ts:131-158`).

**Fix:** port the pi/opencode `callHook`.

### 6. Network and LLM calls inline in Stop (A4: bro-36sx7.4)
- `act/src/connector.ts:218-219`: `stopGate` → `prProbe` → `fetchPrActState` (gh API).
- `cli/src/commands/goal.ts:246`: `await judgeFacade(dir).decide(...)`, an LLM round-trip inside
  the stop hook.
- `hooks.ts:1241-1276`: `guardLines` builds a `judge` in shadow mode, so the decide can also run
  on post-tool and session-start.

These are bounded only by `PROBE_TIMEOUT_MS` (4 s), and only when the event loop is free (#1, #4).
The Stop timeout is 25 s.

**Fix:** Stop reads a cached gate verdict (refreshed by the detached `act watch` or a background
refresh). The goal and guard judges become asynchronous: the verdict is written to a file and
applied on the next stop or post-tool.

## S2: steady cost on every event

### 7. Duplicate hook chain in Devin (bro repo) (A5: bro-36sx7.5)
`.devin/hooks.v1.json` (`"$DEVIN_PROJECT_DIR/hooks/run.sh" …`) and the plugin `hooks.json`
(`P="${DEVIN_PLUGIN_ROOT:-…}"`) both fire. **Both error messages in the report are these two
chains.** Every event runs twice and the two runs contend for the locks in #2 and #3.

**Fix:** delete `.devin/hooks.v1.json`, or have the plugin chain exit when the project has its
own. Add a check to `bro doctor`.

### 8. Extra Node start and npx in `run.sh` (A6: bro-36sx7.6)
- `hooks/run.sh:518`: `command -v bro && bro hooks </dev/null` is a full cold Node start (CLI +
  81 plugin imports) purely as a probe, before the real call.
- `run.sh:521-524`: `npx -y --prefer-offline @broject/bro@0.2.5` runs on every event when the
  plugin has no `dist/` and `bro` is not on PATH. That means the npm CLI plus a possible registry
  round-trip.

**Fix:** use `command -v bro` alone. Remove npx from the hook path: exit 0 and show an install
hint once at session-start.

### 9. Cold start loads the whole registry (A7: bro-36sx7.7)
`cli/src/index.ts` → `plugins.ts` imports every plugin (around 81 imports). The repo's own
estimate is 170–300 ms per event (`specs/bro-arm83.md`).

**Fix:** add a separate entry `dist/hooks.js` that imports only `hooks.ts` and the connectors.
`run.sh` calls it directly.

### 10. `gitCommonDir` is not memoized (A8: bro-36sx7.8)
`hooks.ts:452-458`: `hooksStateDir()` → `gitCommonDir()` → a fresh `spawnSync` on every call. It
is called by markerPath, readArmed, journalTrace, flushPerf, recordGuardEvents, skillHinted,
notify and learn (`:74`). That adds up to roughly 10 git spawns per post-tool.

**Fix:** memoize per process, keyed by `realpath(dir)`. Optionally, resolve `.git` by walking up
the directories without spawning git.

### 11. Exit handler on every command, including hooks (A9: bro-36sx7.9)
`cli/src/index.ts:175-176`: `process.on('exit') → journalCommand` → `hooksStateDir` (a git
spawn) → `appendJournal` (`hooks.ts:1036`, waitMs 0, but still a lock attempt and a sync write).

**Fix:** skip it for `hooks`. The hook already writes its own perf row through `flushPerf`.

### 12. Synchronous mailbox drain on every post-tool (A10: bro-36sx7.10)
`core/src/notify.ts:277-289,393,453`: `readdirSync` plus a `readFileSync` per drop, and a
`.seen-*` cursor (`:196`). It is O(number of drops) and is not cleaned up; the comms spec counted
83 orphaned cursors.

**Fix:** keep a per-session cursor in one file, garbage-collect old drops, and check the
directory mtime before `readdirSync`.

## S3: visibility

### 13. Silent fail-open (A11: bro-36sx7.11)
Errors go to `catch {}`. `flushPerf` runs in `finally`, so it never runs when the host kills the
process (SIGKILL on timeout). Fast-path exits in `run.sh` write nothing. As a result,
`bro hooks perf` does not see exactly the cases that freeze the agent.

**Fix:** `run.sh` writes a `start` line before it calls Node, and the hook writes an `end` line.
A `start` without an `end` is a host kill. This is one `printf >>` in shell.

## Fix order (one PR, mechanical, each item testable)

Two changes decide most of the freezes:

- `waitMs: 0` on all hook-path locks (#1, #2, #3), with a test that the post-tool hook does not
  wait while `agents.json.lock` is held;
- async git on the probe paths (#4), with a test of a probe timeout against a hanging `git` stub.

Next come #5, #7, #8, #10 and #11, which are small local edits. #6, #9, #12 and #13 are separate
PRs.
