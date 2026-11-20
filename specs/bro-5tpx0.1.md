---
parent: bro-5tpx0
---

# bro-5tpx0.1 — bench-hooks: measure the run.sh fast-path exit + budget the hot rows

## Problem

Two gaps keep the epic's thesis ("no-op hooks cost nothing")
unverifiable in CI:

1. **No row exercises the run.sh early-exit.** `buildFixture()` always
   seeds `.beads/beads.json` — a store with no dolt manifest — so
   run.sh's bead-store barometer (`[ -n "$_beads" ] && [ "$_manifest" = 0 ]
   → NEED_NODE=1`) defers every post-tool/prompt-submit to Node and the
   fast path never exits early. `runsh:post-tool p50=240ms` on CI is
   shell preamble + full node dispatch, not the no-op cost bro-arm83
   built.
2. **Budget coverage.** `BUDGET_P50_MS` gates 4 of the measured rows
   (`noop:post-tool`, `noop:prompt-submit`, `runsh:session-start`,
   `runsh:stop`). The hot armed-path rows — `runsh:post-tool`,
   `runsh:pre-tool`, `runsh:prompt-submit`, `dist:session-start`,
   `dist:stop` — are recorded but never gated, so a regression there is
   invisible until a human reads the artifact.

## Design

### A `fast` lane on a fast-path-able fixture

A fourth lane joins `runsh`/`dist`/`noop`: **`fast`** — `sh
hooks/run.sh <event>` against a fixture the early-exit checks can
actually settle. The lane measures only the per-tool-call contract:

- `fast:post-tool`, `fast:prompt-submit` — the two events the shell
  fast path (specs/bro-arm83.md) may settle without Node; steady state
  is an exit-0 after pure shell checks.
- `fast:pre-tool` — never fast-paths (the session-cap veto stays live
  in every mode, specs/bro-izpyk.2.md); it is the armed floor on the
  same minimal repo, the number the fast rows must stay under.

### The fixture variant

`buildFixture('fast')` differs from the armed fixture in exactly the
state the fast-path checks key on:

- **`bro.config.json` only — no `.beads`.** Opt-in still resolves (the
  walk-up finds the config), while the bead-store barometer's `_beads`
  is empty so no manifest proof is demanded. With no `.beads` there is
  also no manifest to invalidate against, so `cache/lessons.json` and
  `cache/drills.json` snapshots are never consulted — they stay absent.
- **A seeded `<git-common>/bro/hooks/guards/.stamp`.** Fresh session
  ids per run (`rowInput`) are correct for armed-state realism but mean
  per-session markers never accumulate; the stamp is repo-level state
  and persists across runs, so the bench measures the steady-state
  early exit rather than the priming dispatch. The body is the
  zero-coverage form `recordGuardEvents` writes (a bare newline — no
  event names, no `.trace`), and it is written after the fixture's
  config files so every `CFGS` entry is older than the stamp.

Everything else is identical: same scrubbed `e2eEnv` pins
(`BRO_HOOK_SPOOL=0`, `BRO_TELEMETRY=0`, `BRO_HOOKS_NO_FALLBACK=1`,
HOME/XDG inside the fixture), same fake `bd`/`docker` on PATH. With
`BRO_HOOK_SPOOL=0` the mode resolution leg never runs (`HOOK_MODE=''`),
so the guards `.stamp` presence check *does* apply — it is the check
the seeded stamp satisfies.

The armed fixture is untouched: `runsh:*`/`dist:*`/`noop:*` keep
measuring against `.beads` + fake bd, so the armed rows stay
comparable to the established baseline.

### Budget table

`BUDGET_P50_MS` gains the hot rows. Numbers are the CI baseline (run
42977847108) with ~1.5–1.7× headroom — the same margin the existing
`runsh:session-start`/`runsh:stop` budgets carry; the `fast:` rows sit
below the armed CI p50 (~240ms) so a fast-path regression that falls
back to Node turns the row OVER instead of passing silently.

| row                  | CI p50 | budget |
|----------------------|--------|--------|
| runsh:post-tool      | 240 ms | 400 ms |
| runsh:prompt-submit  | 251 ms | 400 ms |
| runsh:pre-tool       | 175 ms | 300 ms |
| dist:session-start   | ~355 ms| 500 ms |
| dist:stop            | ~295 ms| 450 ms |
| fast:post-tool       | new    | 200 ms |
| fast:prompt-submit   | new    | 200 ms |
| fast:pre-tool        | new    | 300 ms |

`--enforce` semantics are unchanged: budgeted rows gate p50 with zero
errors; unbudgeted rows are still recorded (and still fail on errors).

## Deliberately not done

- No `fast:` rows for session-start/post-compaction/pre-compact/stop —
  their early exit needs a resolvable session mode (`observe`), which
  needs the spool identity the bench env disables; that fixture shape
  is a different bead's work.
- No cache-snapshot fixture (`.beads` + manifest + `cache/*.json`) —
  the no-`.beads` variant reaches the same steady state with less
  seeded state to keep in lockstep with `beadsStoreStamp()`'s format.
- No tightening of the existing four budgets — this bead extends
  coverage; tightening stays with the E2/E3 children.

## Verify

- `node scripts/bench-hooks.ts` prints `fast:post-tool`,
  `fast:prompt-submit`, `fast:pre-tool` rows whose p50 sits far under
  the armed `runsh:` rows.
- `node scripts/bench-hooks.ts --enforce` exits 0 locally and on CI.
- Deleting the seeded `guards/.stamp` (or adding `.beads` back) must
  push `fast:post-tool` p50 toward the armed number — the row is
  proving the early exit, not just another dispatch sample.
- `node scripts/bench-hooks.ts --lanes fast` runs only the new lane.
