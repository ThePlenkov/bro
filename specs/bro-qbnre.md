---
parent: bro-5tpx0
---

# bro-qbnre — hooks: latency baseline + CI budget

## Problem

Every agent-session event pays a hook process spawn, and post-tool
fires on *every* tool call. The 2026-10-16 architecture review measured
cold hooks on a VM at session-start ~600 ms, stop ~625 ms, post-tool
166–303 ms, prompt-submit ~190 ms — but nothing guards the number. A
probe that regresses from "read a file" to "spawn a CLI" lands
silently, and the cost is paid per event, forever, on every host that
installs the plugin.

The epic (parent bro-5tpx0 — "no-op hooks cost nothing") splits the
work: this bead establishes the measurement and the ratchet; bro-arm83
(shell fast-path for no-op post-tool/prompt-submit) and bro-9wv18
(probe caching/parallelism) bring the live numbers under tighter
budgets.

## Design

### What is measured

`scripts/bench-hooks.ts` spawns each hook event N times in a fresh
process (default 20 + 1 discarded warmup) and reports
`{min, p50, p95, max}` per row as JSON:

- **runsh** — `sh hooks/run.sh <event>` against the quiet fixture: the
  process plugin hosts actually exec — launcher + dist + dispatch.
- **dist** — `node packages/cli/dist/index.js hooks <event>`: the same
  dispatch minus the launcher, so run.sh's share is visible.
- **noop** — `BRO_HOOKS=0 sh hooks/run.sh <event>`: the machine-backend
  skip — the contract that a spawned-agent tree pays ~nothing per
  event (spec bro-ddksm).

*Quiet* = a scratch git repo with `bro.config.json` + `.beads/` served
by the e2e fixture's fake `bd`/`docker` (healthy, empty, deterministic —
a real bd's dolt handshake is a property of the store, not of bro's
dispatch). Ambient env is scrubbed the way the e2e harness scrubs it —
PATH/HOME/TMPDIR/USER/LANG only, HOME + XDG pinned into the fixture so
the operator's global bro config, mailbox, and `provider.env` cannot
leak in; `BRO_TELEMETRY=0` keeps the OTLP plane out of the number.

Payloads are minimal valid hook JSON (devin/claude shape). Each run
gets a fresh session id — the trace journal and skill-hinted markers
otherwise leak state between iterations and later runs would measure a
different session.

### Budget

`--enforce` compares each budgeted row's p50 to the committed budget
(the defaults below live in the script; `--budget <file>` overrides):

| row                   | p50 ≤  |
|-----------------------|--------|
| noop post-tool        | 150 ms |
| noop prompt-submit    | 150 ms |
| runsh session-start   | 600 ms |
| runsh stop            | 600 ms |

These are the bead's stated budgets, on the lanes where they are
meaningful today: the no-op lane is already ~10 ms (a shell test —
spec bro-ddksm), and live session-start/stop sit inside 600 ms on
ubuntu-latest. Live post-tool/prompt-submit are recorded but not yet
gated — bro-arm83's fast-path and bro-9wv18's probe caching are the
work that brings them under budget; they add their rows' budgets when
they land (the "tightened by E2/E3" half of the bead's design).

### CI

Two steps appended to `build-test` (the dist is already built there —
a separate job would re-pay `npm ci` + nx):

- `node scripts/bench-hooks.ts --out hooks-latency.json --enforce`
  — a p50 over budget fails the step.
- `actions/upload-artifact` uploads `hooks-latency.json` with
  `if: always()` — the numbers matter most on the run that fails.

## Deliberately not done

- No live-lane budget on post-tool/prompt-submit — E2/E3's tighten,
  not the baseline's.
- No git-hook events (prepare-commit-msg, reference-transaction,
  post-merge) — a different contract (installed shims, argv not JSON),
  never on the per-tool-call path.
- No cross-run trend store — the artifact is the record; a flake
  policy (retries, median-of-jobs) is debt if p50 proves jittery.
- The OTLP drain found while measuring — with an endpoint configured,
  `otelSpan.end`'s fetch keep-alive holds the hook process ~10 s past
  its output. Filed as its own bead; pinned out of the bench by
  `BRO_TELEMETRY=0`.

## Verify

- `node scripts/bench-hooks.ts` locally prints p50/p95 rows for every
  event × lane; `--enforce` exits 0 here and on CI.
- `--budget <file>` with a 1 ms cap fails the step — the gate is real,
  not decorative.
- The CI artifact `hooks-latency.json` carries the numbers.
