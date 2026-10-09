# bro-snga4 — the loop must never exit silently mid-run

## Problem

Twice in a row, `bro loop` vanished between the acp worker's
`end_turn`→exit and the next claim line — no bead note, no `loop: done`
tally, no end-of-run audit. `runQueue` is a `for(;;)` — a clean
mid-queue exit is impossible, so whatever took the process down
bypassed every observable path. The suspected mechanism is an awaited
promise that never settles while every live handle is unref'd (the
event loop drains and Node exits 0 mid-run); an external SIGTERM fits
the same log shape — one later wrapper exit was recorded as 143.

Under the current code every `await` in the item path holds a ref'd
handle (the spawned child, the timeout timer, a pipe socket), so no
specific drain is reachable — and that is not the point. The contract
violation is identical whatever the mechanism: **a run died and left
nothing naming where it was suspended or which bead it held.** The fix
is a liveness contract, not a guess at one await.

## Design

A run-open liveness guard in `runLoopCommand`, wrapping `runQueue`:

1. **Heartbeat — the drain prevention.** A ref'd `setInterval` for the
   run's duration is a live handle the event loop can never drain
   around, so a never-settling await can no longer end the process —
   it becomes a visible stall: each tick prints
   `loop: alive — <stage> [on <bead>]` naming the suspension point.
   The interval rides `--interval` (gate poll cadence).
2. **Death audit — the audit of last resort.** A `process.on('exit')`
   listener covers `process.exit`/natural-end deaths — signals never
   emit `'exit'`, so `SIGTERM`/`SIGINT` get handlers that audit then
   remove themselves and re-raise, leaving the parent a true signal
   death (143/130), not a clean code. Every mid-run death prints
   `loop: process exiting mid-run — <stage> [on <bead>]` and notes the
   bead (`loop: process exited mid-run — <stage>`). The line is
   `writeSync(2)` — an async `console.error` dies with the process on
   pipes — and the note is a sync `bd update` (the same shape
   `journalCommand` already runs inside `'exit'`).
3. **Stage tracking.** `ctx.stage`/`ctx.bead` are set at the await
   boundaries so the lines name where the run sat:
   `claim` → `worktree` → `bootstrap` → `worker pid=N` → `pr lookup` →
   `gate pr=N` → `fix round N` → `merge pr=N` → `audit`. `ctx.bead` is
   cleared between items so a death while idle notes nothing stale.

The heartbeat prints to stderr — diagnostics, not the `--json` event
stream. A stage that hangs legitimately (a wedged child, a blocking
sync call) now leaves a repeating trail naming itself instead of a
vanished process.

## Non-goals

- No specific await is "fixed" — none is provably stuck under the
  current handle set. If one exists, the heartbeat surfaces its stage.
- No new flags: the heartbeat rides `--interval`; the exit audit is
  unconditional while a run is open.
- `spawnCollect`'s `'close'`-on-held-pipe hang is a *hang*, not the
  reported exit — out of scope.
