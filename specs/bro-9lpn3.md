# bro-9lpn3 — loop agent kill must be stall-based, not wall-clock — a hard SIGKILL on a working session is an anti-pattern

## Problem

`bro loop` spawned its worker with a wall-clock guillotine: at
`loop.agentTimeoutMin` (default 45m) the whole detached process group
took a SIGKILL mid-write, mid-push, mid-anything. The number was never a
worker lifetime — it was the *orchestrator's* check-in cadence leaked
into the spawn path. A session deep in real work reads identical to a
wedged one on a wall clock, so the kill decapitated healthy runs
(indeterminate commits, torn pushes) to save nothing.

The stopgap shipped in this repo's local config pinned
`agentTimeoutMin` to a year — a knob rotated to "never" is the knob
admitting it shouldn't exist.

## Design

(1) **The worker spawn awaits completion unconditionally.** No timer,
no kill path, no `agentTimeoutMin` config or `--agent-timeout` flag —
a removed flag fails closed (`unknown option`) rather than silently
arming nothing. The child stays `detached` so a terminal interrupt of
`bro loop` cannot group-signal the worker mid-write: interrupting the
loop is an accident, not an orchestrator decision.

(2) **Supervision stays in bounded watch/wait commands that EXIT
physically.** `bro watch --every N --for S`, `bro act wait`'s gate
budget, and the deployment's `timeout` wrappers bound their window and
exit — the orchestrator inspects and re-arms. No immortal watcher, no
in-process supervisor thread.

(3) **Stall detection is an advisory read at check-in, never an
auto-kill.** The loop records each in-flight spawn at
`<git-common>/bro/loop/<slug>.json` (`{beadId, pid, startedAt,
worktree, log}`) and hands the child an append fd on
`<git-common>/bro/loop/<slug>.log` for stdout/stderr — file-only,
never a pipe back to the loop's console: a dead loop would turn the
worker's next write into a SIGPIPE kill, and the file transcript
survives the loop either way. `bro watch` gains a `loop` plane and `bro status`
a `loop` line: a live record whose log mtime is older than
`loop.stallMin` (45) renders as an attention advisory — `agent <bead>
— output silent N min` — for the orchestrator to judge. A record whose
pid is dead is residue: reported as such, reaped on the next `bro
loop` start. The `.log` persists as the audit trail across fix-round
respawns (append, like the agents-plane convention).

`<git-common>/bro/` not `bro/agents/`: the loop spawn stays
synchronous per spec bro-c3no8 — no registry row, no fleet slot, no
`.exit` file — and the janitor's orphan sweep would reap
unregistry-owned files from `bro/agents/` anyway.

## Non-goals

- No auto-kill is reintroduced anywhere. The decision to stop a stalled
  worker is the orchestrator's (`bro agents down`, `kill`, a session
  nudge) — bro surfaces the signal, it does not act on it.
- The loop's claim/dedup semantics are unchanged — the record is a read
  model for check-ins, not a lock.
- `mergeTimeoutMin` is untouched — a *gate* bound (park the item when
  the review loop stalls) is a different beast from a worker lifetime.

## Plan

- [ ] `loop` config: `agentTimeoutMin` out, `stallMin` in (default 45)
- [ ] `spawnAgent`: unconditional await; stdout/stderr appended to
      `bro/loop/<slug>.log` over an open fd — no pipe, no console tee;
      run record written at spawn, cleared on settle; stale-pid records
      reaped at run start
- [ ] `bro watch` loop plane + attention advisory; `bro status` loop
      section
- [ ] drop `--agent-timeout` flag; docs (skill, site, bro-c3no8 spec)
- [ ] tests: config normalization, run-record collect (live/dead/missing
      log), watch render + advisory
