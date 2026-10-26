# bro-36sx7.13 / .14: hard hook deadline and the last unbounded waits

Follow-up to the bro-36sx7 perf review after #701 and #706–#709 merged.

## Problem

- Internal hook budgets (`probeWithTimeout` 4 s, `boundedMs` 4 s) are Promise timers. They cannot preempt synchronous work (`spawnSync`, `Atomics.wait`).
- `hooks/run.sh` has no watchdog. Every synchronous call on the hook path is now bounded on its own (git 1.5 s, locks 0–500 ms). Their sum plus the 4 s async probes can still exceed the host's 10 s hook timeout, so the host can still kill the hook and freeze the agent.
- `drill/src/connector.ts` `hooksDir` (session-start, stop) and `learn/src/store.ts` `withStoreLock` call `gitTry` with no timeout. A hung git blocks the hook until the host kills it.

## Contract

A hook never runs longer than its own deadline. The deadline is always below the shortest host timeout (10 s). Past the deadline the hook exits 0 with no output (fail-open). For a Cursor permission event, it answers the no-opinion response `{"permission":"ask"}`.

## Design

### .14: bound the remaining waits

- `drill` `hooksDir` and `learn` `withStoreLock` resolve the common dir through `gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS)`. That call is bounded and cached per process.
- Lock waits reachable from hook dispatch use `waitMs: 0` with their existing fallback. Candidates: the learn gap lock (`learn/src/probe.ts`, 2 s today) and `withStoreLock` (20 s default).

### .13: two-layer deadline

1. **Node:** `runHooksCommand` arms an unref'd timer, `BRO_HOOK_DEADLINE_MS` (default 6000). When it fires, the hook:
   - appends a `deadline` perf row, the only visibility for this case until .11 lands;
   - answers Cursor permission if it has not answered yet;
   - calls `process.exit(0)`.

   On normal completion the timer is cleared.
2. **Shell:** `run.sh` and its generated plugin copies run bro under a background watchdog, `BRO_HOOK_WATCHDOG_S` (default 8). On expiry the watchdog sends SIGKILL to bro and the launcher exits 0. This layer covers synchronous blocks that the Node timer cannot preempt.
   - The watchdog subshell has stdin, stdout and stderr on `/dev/null`, so a leftover `sleep` cannot hold the host's pipes open.
   - The bro job keeps the hook payload on stdin through an explicit redirect, because a background job in non-interactive sh otherwise gets `/dev/null`.

Defaults: 6 s < 8 s < 10 s, the shortest host timeout.

## Out of scope

- `.4`: Stop/judge off the hot path.
- `.7`: slim hook entry.
- `.9`, `.10`.
- `.11`: start/end spool telemetry, next in line.
- Deadlines inside the TS adapters (opencode, pi, omp, kilo), which already have their own spawn timeouts.

## Verification

- Unit/e2e: with `BRO_HOOK_DEADLINE_MS=1`, `bro hooks post-tool` exits 0 promptly and writes a `deadline` row.
- With a stub `bro` that sleeps 30 s and `BRO_HOOK_WATCHDOG_S=1`, `run.sh` exits 0 within about 2 s. A non-sleeping stub still receives the stdin payload.
- `drill`/`learn` git lookups are bounded (stub git that hangs returns within the budget).
- `npm run gen:plugins` and `check:plugins`, typecheck, targeted tests.
