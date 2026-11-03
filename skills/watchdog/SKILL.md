---

name: watchdog
description: "Run the infinite read-only watchdog loop over the bro pipeline — one background tick subagent at a time, chained after each WAKE|TIMEOUT verdict; tick-0 baselines come from `bro watchdog`, never from memory."
---

# Watchdog — the endless orchestration loop

The watchdog keeps a continuous read-only watch over the bro pipeline
(loop workers, PR queue, merge chain, system health) by running **one tick
at a time**: each tick is a background subagent that polls for ~10 minutes
and closes with a verdict; the orchestrator reports events and immediately
places the next tick. The loop has no natural end — only the operator stops
it.

The loop is model work; `bro watchdog` owns the facts. Never quote a
remembered number — baselines are measured at launch and re-measured every
tick.

## Launch

```text
/bro watchdog          # opencode: runs `bro watchdog`, feeds brief back as the prompt
bro watchdog --json    # same facts, machine-readable (other clients / tools)
```

The brief prints the launch steps plus tick-0 baselines (unit, daemon,
loop.out, PR count with our/foreign split, /tmp, swap/mem, worktrees,
slots). Then:

1. Load this skill (already in context if you are reading it).
2. Adopt the printed baselines as tick 0.
3. Spawn tick 1 as a **background** subagent; when it closes, report the
   verdict and place the next tick.

## Tick contract

- **One tick = one background subagent.** The next tick is placed only
  after the previous one has closed with a verdict — never two in flight.
- **Window:** ≥10 minutes, ≥5 polls at 60–120 s intervals. The opening
  snapshot does not count as a poll. An event found before the fifth
  poll keeps the tick polling until the minimum is met, then closes as
  WAKE — the minimum is a floor, not a target. Never hang: close the
  window with a verdict even when nothing happened.
- **Verdict:** `WAKE` (an event fired) or `TIMEOUT` (window closed clean).
- **Report shape:** verdict / lane / reason / PR / units / anomalies /
  plan for the next tick. Facts only — every line traceable to command
  output from this window.
- **READ-ONLY, no exceptions:** no kill, merge, push, commit, checkout,
  worktree remove, restart, or file deletion. The tick never runs `gh
  merge` (auto-merge is armed — green merges itself). Only the loop spawns
  workers; only the operator/assistant cleans up.

### Tick prompt skeleton

Compose each tick's prompt from fresh baselines + this skill's rules:

```text
role: read-only watchdog tick · verdict WAKE|TIMEOUT · full window, ≥5 polls
context: <baselines from `bro watchdog` / previous tick's plan>
watch first: <the one metric under pressure this window>
stop conditions (after the ≥5-poll minimum): (a) escalations (b) events (c) harbinger greenings (d) window end
report: WAKE|TIMEOUT / lane / reason / PR / units / anomalies / next-tick plan
```

## Anti-fabrication

- Facts only from command output produced **inside this window**. A number
  from memory is a fabrication, even if it was true an hour ago.
- Time from `date -u` or a GitHub `Date:` field. Human-readable `stat`
  output (`%y`) is local time (`+0100` here) — convert it before comparing
  against UTC; epoch numbers (`stat -c %Y`) are already absolute — compare
  them directly, no offset.
- **native-ids are reused.** Liveness = the pid **and** that run's
  recorded `/proc` start time (`pidAlive(pid, pidStart)`) — a bare pid
  check can be satisfied by a recycled pid. The reason for an exit comes
  only from the **fresh** `.log`/`.exit` of that run, never an old file
  that happens to share the id.
- A failed probe (gh blip, missing shell) → query GraphQL/REST directly or
  mark the fact _unverified_. Never fill a gap with a guess.
- Degrade honestly: `unavailable (why)` beats a plausible lie.

## PR classification

Our PRs: `loop/*`, `fix/bro-*`, `stack/*`, `work/bro-*`.
Everything else — `fix/*` without `bro-`, `herdr/*`, `devin/*`, `feat/*`,
`docs/*`, dependabot — is foreign: background, never touched.
Count with `gh pr list --state open --limit 100 --json number,headRefName`.
That query is a **capped sample**: exactly 100 rows means the baseline is
truncated — mark it `capped` and treat rises/drops as unreliable until
the query paginates.

## Escalations — quote from fresh output, report, never fix

- `daemon.log` age growing monotonically **past 30 min** while the writer
  pid lives; or the writer vanishing without a replacement.
- New `ETIMEDOUT` line above the sticky baseline (loop.out / daemon.log).
- `bro-loop` MainPID change or `NRestarts > 0` (journal quote).
- **New** iceman-compaction / opencode-login quote on an exit ≠0
  (`Compaction produced no summary` — the long-session death pattern).
- Fresh `bd unusable` / `bd exited 124` above the historical line numbers.
- `/tmp` at/above 85% → report with `df -h /tmp`. **Cleaning is the
  operator's/assistant's job, never the tick's.** Also report the `disk
  below floor` counter — it means loop pushes are held.
- Swap used ≥8.5 GiB or Mem used ≥9.5 GiB — host defaults; the tick's
  prompt restates the exact figures it compares against → report with
  `free -h`.
- A `fix-round cap hit` blocker appearing (config pins `act.maxRounds=999`)
  = config not picked up = anomaly report.
- acp-worker count ≥6.

## Events — report, don't act

- **PR count drops** = a PR left the open set — verify it was _merged_
  (not closed unmerged) and which one (`headRefName`) before calling it
  auto-merge; report, and note worktree hygiene (a merged worktree is
  _reported_, never deleted).
- **PR count rises** = new PR → classify ours/foreign.
- Thread counts (#816/#801/#725 style baselines) hitting 0 = resolve/merge
  event; growth = report.
- Slot exit: code 0 = routine (say so); ≠0 = quote the fresh log; a new
  spawn = report with native-id + pid.
- Greenings are **harbingers**: Codacy/build-test/Sonar going green on an
  armed PR predicts its merge in the next window.
- `loop: done`, `claim read failed` → event with a quote.

## Untouchables

devin environment and its panels · herdr observer panels (w46–w49) ·
the store-drill agent · the e2e fake-agent · worktrees hosting live
processes or open PRs · anything in another project's tree.

## Known pitfalls

- `bro review act status` / `bro review act threads` may fail with an
  empty `gh api failed:` — use direct GraphQL or `bro act status <PR>`.
- daemon.log "breathing": cadence 300 s with pauses up to ~13 min is
  context, not a stall — only a monotonic climb past 30 min escalates.
- ETIMEDOUT baselines are sticky _line numbers_ in append-only logs; the
  value is the reference, the fresh line above it is the signal.

## Stop conditions

The operator says stop · the operator closes an open drill frame with
`--result` before the loop may end · a tick never stops the loop itself,
and the loop never stops on a quiet window.
