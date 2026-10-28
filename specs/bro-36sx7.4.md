# bro-36sx7.4 — stop: cached gate verdict, judge off the hot path

Review finding #6 of `specs/sessions/bro-36sx7.md` (severity S1): the Stop
hook runs network and LLM calls inline —

- `act/src/connector.ts` `stopGate` → `prProbe` → `fetchPrActState`
  (5–7 review-host calls on a cache miss);
- `cli/src/commands/goal.ts` `goalStopLines` → `judgeFacade().decide()`,
  a model round-trip inside the hook;
- `hooks.ts` `guardLines`' judge clause — `facade.decide()` can run on
  stop, post-tool, and session-start alike.

These are bounded only by `PROBE_TIMEOUT_MS` while the event loop is
free; when it isn't (sync locks, spawnSync — bro-36sx7.1/.2) the host
kills the hook at its timeout and the agent freezes.

## Contract

No model call and no review-host fetch runs inside a hook process.
Verdicts are computed by detached `bro` children and consumed from files
on the NEXT hook event.

### act stopGate — cached verdict only

- `stopGate` resolves the branch PR, then reads ONLY `prStateCache` —
  `fetchPrActState` never runs on the hot path.
- Cache hit → `evaluateExitGate` on the cached state → the same
  block/passive contributions as today (the approval-probe provenance
  check is preserved — a cached entry fetched under different
  `requireApproval` semantics never serves).
- Cache miss → claim a per-target refresh stamp (`claimRefresh`,
  throttled, skipped while a peer's fetch holds the feed lock) and spawn
  `bro act status --pr <n>` detached — the command already publishes the
  shared cache as its read's side effect. Emit:
  - live watch → `[]` (a poller publishes; nothing for this session);
  - no live watch → a `block` naming the honest state ("gate verdict
    pending — no live act watch") with the same remediation as the
    green case (`bro act wait --detach`). The gate's invariant is
    "verdict known or watcher armed" — an unwatched PR with an unknown
    verdict is exactly what the gate exists for. A miss is never a
    fabricated gate verdict: the block names the watch invariant, which
    is local state.
- The detached spawn only fires when `process.argv[1]` is bro-shaped —
  a test runner's argv re-runs the suite as a child, so hook-spawn
  helpers refuse it outright.

### goal judge — queued eval

- `goalStopLines` never calls `decide`. With the judge configured it:
  1. writes `<git-common>/bro/hooks/goal/<session>.req.json` (trace +
     context snapshot, tmp+rename) unless a fresh req already marks an
     eval pending;
  2. spawns `bro goal eval --session <id>` detached;
  3. emits lines derived from the record (reminder, or the per-stop
     "turn N — not yet met" from `lastVerdict`) plus any landed
     `.notice`.
- `bro goal eval` (internal verb) reads the req, calls the real
  `judgeFacade`, and runs the existing locked finish-merge — lastVerdict,
  evals/budget, status transitions, journal row — then writes
  `<session>.notice` when a transition announced itself, and removes the
  req only on a produced verdict (a thrown/wedged decide leaves the req
  to age out, which is the retry backoff).
- The notice is consumed once by a later `goalStopLines` (atomic
  rename-claim), so met/impossible/budget announcements still surface
  exactly once.

### guard judge — queued verdict facade

- `guardLines`' judge wiring swaps `judgeFacade(dir)` for a queued
  facade: `decide(state, questions)` claims a landed verdict file for
  the guard when present, otherwise writes the request under
  `<git-common>/bro/judge/guard/` and spawns `bro guard eval` detached
  (throttled by a repo-level stamp) — answering an empty answer set,
  which is the engine's existing "no noul answer" abstain.
- `bro guard eval` (internal verb) drains pending requests against the
  real `judgeFacade`, writes each `DecideResult` to the guard's verdict
  file, and removes the request.
- A landed verdict applies once (rename-claim consume) on the next
  event whose deterministic clauses pass; journaling stays where it is
  today — `journalGuardDecision` records the applied verdict, model and
  latency included.
- `bro guard test` keeps the synchronous facade — it is the honest read
  of what the hook would do, and it is not a hook path.

## Non-goals

- `gateLine` (session-start/prompt-submit) does the same fetch and is
  not in review #6's scope — the stop path is the S1 stall.
- Sync git spawns and lock waits on the hook path — bro-36sx7.1/.2's
  territory; new code here only reuses existing resolvers
  (`goalDir`, `gitCommonDir`) and adds no new blocking wait.

## Fail-open invariants

- Every file op is tmp+rename or rename-claim; a torn, absent, or
  corrupt entry degrades to abstain / no contribution.
- A wedged eval child only leaks a req/stamp file — TTL expiry re-arms
  the spawn on a later event.
- No hook-path code waits on a lock or awaits a network/model call.

## Plan

- [x] `act`: `cachedPrActState` read + `claimRefresh` stamp; `stopGate`
  reads the cache and kicks a detached `act status` on a miss.
- [x] `goal`: req file + detached `bro goal eval` worker + `.notice`
  one-shot channel.
- [x] `guard`: queued facade + `bro guard eval` drain worker.
- [x] `spawnSelf` in core — the bro-shaped, detached, unref'd child
  spawn all three share.
