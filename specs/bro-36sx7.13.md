---

## parent: bro-36sx7

# bro-36sx7.13 — hooks: hard wall-clock deadline (Node deadline + run.sh watchdog)

## Problem

The hook's per-probe budgets are promise races: `probeWithTimeout` /
`boundedMs` (4s) bound _awaits_, but cannot preempt synchronous work —
`readFileSync(0)` on a slow stdin, a wedged sync spawn, a dolt call
parked in a syscall — and they bound each call in isolation, so a sum
of bounded calls can still blow the host's ~10s hook timeout. Nothing
else stands between a slow hook and the host's verdict (silence on a
Cursor permission hook reads as a **deny**).

Two complementary bounds are needed: one inside Node that fires while
the event loop still yields between awaits, and one outside that fires
even when the loop never gets a turn.

## Design

**Node deadline — `runHooksCommand` (hooks.ts).** One unref'd
`setTimeout` armed at dispatch start. `hookDeadlineMs()` resolves the
budget: default `6000`ms, `BRO_HOOK_DEADLINE_MS` overrides when the
value is a safe positive integer **at or under `2_147_483_647`** —
Node's 32-bit timer ceiling. A larger value is not "no deadline": Node
schedules it as ~1ms, which would expire the dispatch instantly and
strip every gate's verdict, so over-ceiling falls back like any invalid
value. On expiry:

1. Answer a Cursor `permission` event with the no-opinion
   `{"permission":"ask"}` **first** — silence is a deny, and the
   journal flush below is best-effort sync I/O that must never get to
   decide whether the answer left the process. `emit` itself writes
   synchronously (`writeSync(1, …)`, buffered-stream fallback) so the
   line is on the wire, not queued behind whatever follows.
2. `flushPerf(…, deadline: true)` — the deadline shows up in
   `bro hooks perf` as a timed-out event row. Fail-open like the
   journal itself.
3. `process.exit(0)` — through a `stdout.write` drain barrier so
   anything still queued flushes before exit; the run.sh watchdog
   backstops a pipe that never drains.

The timer is armed only on the stdin-event path (after the
operator/git-hook early returns): those surfaces have no 10s host
timeout. `clearTimeout` in the existing `finally`; unref'd so a fast
event never waits on it.

**run.sh watchdog — `run_bounded`.** The launcher is the outer bound
that also covers the sync cases the timer cannot reach. The budget is
**script-wide**: `BRO_HOOK_T0` is stamped at launch and each
`run_bounded` call gets only the _remaining_ window of
`BRO_HOOK_WATCHDOG_S` (default `8`, empty/non-numeric/zero → 8) — the
dist→`bro` fallback cannot stack a second full window past the host's
~10s. An expired call sets `RUN_BOUNDED_EXPIRED` and never retries the
fallback.

Per invocation the binary runs in the background next to a detached
watchdog subshell:

- `wait` reaps the moment the child exits; a marker file written by the
  dog is the expiry verdict (wait-status heuristics can't distinguish
  "killed by our dog" from a self-signalled hook — the marker can).
- At the deadline the dog records the child's direct kids (`pgrep -P`)
  **before** signalling: once the parent dies they reparent to init and
  `pkill -P` sees nothing. Then TERM to kids+parent (`_kill_tree`), a
  one-second grace, KILL to the pinned kids, then a final `_kill_tree
  KILL` sweep — a TERM-ignoring straggler cannot hold the host's stdout
  pipe past the deadline.
- When `wait` returns on the expired path the launcher gives the dog's
  KILL leg a bounded 2s to finish before reaping it — cancelling the
  dog mid-escalation was the pipe-retention hole.
- POSIX hands async commands `/dev/null` on stdin before explicit
  redirects apply — `run_bounded` pins the real stdin on fd 3 in the
  foreground and the child reads `<&3`. fd 0 may also be _closed_ at
  launch: `exec` is a POSIX special builtin whose failed redirect exits
  the script before `||` runs, so the dup is
  `{ command exec 3<&0 || command exec 3</dev/null; } 2>/dev/null` —
  `command` drops the exit rule and the group redirect swallows the
  diagnostic without persisting.
- For the captured fast-path events (`post-tool`/`prompt-submit`) the
  payload rides a `PAYLOAD_FILE` instead — stdin replay is already
  solved there.

**Launcher-level Cursor answer.** A watchdog-killed or unrunnable
binary prints nothing — a deny for `beforeShellExecution`. When a
`permission` run expired or no candidate could run, the launcher emits
`{"permission":"ask"}` itself (`cursor_permission_ask`) — the same
no-opinion the Node deadline sends.

## Plan

- [x] `hooks.ts` — `hookDeadlineMs` (`BRO_HOOK_DEADLINE_MS`, default
  6000, ≤2³¹−1), unref'd deadline timer in `runHooksCommand`:
  synchronous cursor `ask` before `flushPerf`, deadline perf row,
  drain-barrier `process.exit(0)`; `emit` via `writeSync`
- [x] `hooks/run.sh` — `run_bounded` shares `BRO_HOOK_T0` budget across
  candidates; detached watchdog TERM→pinned-kids-KILL→KILL; bounded
  KILL-leg wait; closed-fd0-safe fd-3 pin; `cursor_permission_ask` on
  expired/no-binary `permission`
- [x] `npm run gen:plugins` — fan out run.sh to the plugin copies
- [x] tests — unit: deadline env parsing incl. over-ceiling; e2e:
  watchdog kills a wedged run inside one budget, straggler KILLed,
  killed permission run still answers `ask`, fallback owns only the
  leftover window, closed fd 0 survives
