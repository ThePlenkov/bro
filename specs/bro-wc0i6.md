# bro-wc0i6 — Hook probe latency: overlap serial stages + memoize session context

## Problem

Every hook invocation stacks independent probe stages serially, so the
hook total is a sum of latencies rather than a max. Telemetry evidence
(`bro telemetry` / perf journals):

- `stop` ≈ 6.4s — `goalStopLines` (with `sessionContextText`) →
  `stopGateContributions` → `guardLines`, three awaited stages.
- `session-start` ≈ 6s — `sessionStartProbe‖parallelLines` (parallel
  pair, ~4s) then `guardLines` (~1.5–2s, which builds
  `sessionContextText` again for the guard match context).
- `prompt-submit`/`post-tool` — same shape: probe sweep → `guardLines`.
- Per-probe budgets are 4s (`PROBE_TIMEOUT_MS`) while individual
  connector probes average 3.1–4.3s — 33–89% PROBE_TIMED_OUT rates mean
  context is frequently absent because a probe blew its budget.

`sessionContextText` (repo + branch + claimed beads + mol steps — 2 git
spawns + N `bd get` + 2 `bd list`, each paying the dolt handshake) is
rebuilt on every event even though claims/branch state barely moves
inside a turn.

## Design

**Overlap independent stages.** Connector probes, the goal/context
build, and `guardLines` are independent reads — fire them together with
`Promise.all` and keep the emission order unchanged:

- `emitStopGate`: `goalStopLines‖stopGateContributions‖guardLines` —
  the `stop_hook_active` early-return still emits only goal lines;
  guards fire eagerly and their rows are journaled even on a block
  (verdict rows are records, not output).
- `emitSessionContext`: `sessionStartProbe‖parallelLines‖guardLines`.
- `emitPromptContext`: hydrate pair ‖ `promptContextLines` ‖
  `guardLines`.
- `emitPostTool`: `journalTrace` stays strictly first (a lesson
  triggered on this landing must see its own trace line), then
  `postToolLines‖guardLines`.

Gate contributions themselves are never cached — the stop gate decides
`block`; staleness there is a correctness hazard.

**Memoize `sessionContextText` across hook invocations.** File cache at
`<git-common>/bro/hooks/cache/ctx-<sha1(dir|sessionId)>.json` with a 30s
TTL, atomic tmp+rename writes, fail-open reads (torn/absent →
recompute), and an opportunistic sweep that deletes past-TTL entries on
write. Advisory text only — stale-by-seconds claims lists never feed a
gate decision.

## Non-goals

- Serializing fixes *inside* `runGuards`/`evalProbes` (per-def probe
  calls, `liveState`) — the 26s post-tool spikes come from there; a
  follow-up bead tracks per-probe parallelization and budget enforcement.
- Changing `PROBE_TIMEOUT_MS` or connector probe internals — after the
  overlap, timeouts should be rare; if a connector is still reliably
  slow, degrade-to-skip is the follow-up.

## Validation

- `bro telemetry` before/after on the same repo: `stop` and
  `session-start` totals drop from ~6.4s toward the slowest single probe.
- Unit: cache hit/miss/expiry; hooks tests stay green unchanged
  (emission order and contract preserved).
