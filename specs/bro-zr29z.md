# bro-zr29z — `bro wait`: `--timeout` bounds subprocess reads, not just poll turns

## Problem

`bro wait external:<rig>:<id> --timeout N` promises a bounded watcher:
the verdict arrives inside N seconds. The bound was soft — the loop
checked the deadline *between* poll turns, but each turn's subprocess
reads carried their own fixed timeouts: a hung `dolt sql` on a replica
blocked up to 120s, `bd` store reads up to 15s each, `gh`/`wl` calls up
to 120s. A `--timeout 5` wait could overshoot by ~120s per ref — the
deadline governed turns, never the reads inside them.

PR #859 plumbed the remaining-budget slice into the replica `dolt()`
calls (`watchPollSlice` → `readDepState` → `shippedIssues`/`meshIssues`)
and through `meshScan`'s per-peer legs. Three seams still overshoot
the deadline on main — the same defect class on the other transports:

- **posting-store / local-checkout `bd` reads** — mesh's wait path
  duck-types `getWithTimeout`/`listWithTimeout`/`probe` on the store,
  but `TaskStore` never grew those members: every check falls back to
  `store.get`/`store.list` at bd's fixed 15s. A hung posting store
  overshoots ~15s per read, several reads per turn.
- **wasteland `wl` board reads** — `browseWanted`/`wantedStatus` spawn
  `wl` at a hardcoded 120s; `scanWastelandPeer` accepts no budget at
  all. A hung commons read is the original 120s bug, unmoved.
- **github thread-path `gh` reads** — `issueComments` in
  `admitSelfRepoGithub` and the lazy `gh api user` login probe run
  inside `meshThread` with no slice of the caller's budget (120s each).
- **`meshThread` double-grant** — `ownBeads` and `meshScan` each get
  the full `timeoutMs`, so the call can spend twice its slice; the
  only bound was a caller-side halving quirk (`threadReadSlice`).

## Contract — `--timeout` is a real bound

`--timeout N` bounds the wait's wall clock to ~N seconds. Every
subprocess read a poll turn makes — `dolt`, `bd`, `gh`, `wl` —
receives a slice of the **remaining** deadline, capped by its own
default (dolt/gh/wl 120s, bd 15s, git 1.5s). The slice is recomputed
per call, never re-granted: sequential reads share one budget, and the
in-flight call's kill latency is the only overshoot.

- `--timeout 0` waits unbounded: every read falls back to its default
  cap — the day-to-day contract of `bro mesh wait` (an unbounded point
  check) is unchanged.
- A slice under 1ms is not a read: the leg reports
  `budget exhausted`/`skip`, the loop settles `timeout` (exit 4) — a
  0ms subprocess `timeout` means *unbounded* to spawnSync, never pass
  it through.
- N unsettled refs split one deadline (`remaining / unsettled`,
  capped 120s) — the budget covers ALL reads in a turn, it does not
  reset per call.
- Read failures stay verdicts, not crashes: a killed subprocess lands
  in the per-watch blip budget (3 → `unreadable`), a budget-exhausted
  leg leaves the watch unsettled for the deadline to claim.

## Design

- **`TaskStore` bounded reads** (core) — `probe(args, timeoutMs)`,
  `getWithTimeout(id, timeoutMs)`, `listWithTimeout(filter,
  timeoutMs)` as OPTIONAL members; the beads implementation routes
  them through the existing `StoreExec.probe` (`bdTry`/`bdAt` already
  carry per-call timeouts). Backends that can't bound a read (jira)
  simply omit them — the mesh callers keep their `store.get`/
  `store.list` fallback, so an unbounded backend degrades to the
  backend's own default, never to a fake bound.
- **`meshThread` internal deadline** — `call.timeoutMs` becomes one
  absolute deadline shared by `ownBeads` → `meshScan` →
  `admitSelfRepoGithub` in sequence; each leg gets the recomputed
  remainder. `lazyLogin`'s one `gh api user` call reads the remainder
  at fire time. Callers passing no `timeoutMs` (`bro mesh wait`,
  lifecycle verbs) see the old defaults.
- **wasteland/github params** — `wl`, `wlJson`, `browseWanted`,
  `wantedStatus`, `selfLogin` accept `timeoutMs`; `scanWastelandPeer`
  and `admitIssueComments` take and forward it. Same shape as the
  `dolt`/`gh` seams #859 already cut — an optional trailing param,
  `undefined` = the fixed default.

## Non-goals

- `bro mesh wait`'s own contract: it stays an unbounded point check —
  the changes only add optional params it never passes.
- `bro mesh inbox`/`pull`/`request` — command paths, not the watcher;
  their per-call defaults stand.
- `git` subprocess reads inside the wait path (`remote get-url origin`
  in `selfRig` and `admitSelfRepoGithub`) DO take the shared slice —
  a hung probe would otherwise overshoot the deadline like any other
  read; unbounded callers keep today's no-timeout behavior.

## Tests

- e2e (fixture fakes): a wedged `bd show`/`dolt sql` under a tiny
  `--timeout` must exit within the deadline, not at the tool's default
  — elapsed-time assertion on the CLI subprocess.
- unit: `meshThread` budget-sharing and per-call slice math stay under
  the existing pure seams.
