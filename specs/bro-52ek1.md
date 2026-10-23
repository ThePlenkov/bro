# bro-52ek1 — tests: hermetic git fixtures + fake clock for loop/drive e2e

## Problem

On a clean VM `npm test` fails 5/~2,250 (architecture review
2026-10-16):

- `notify.test.ts` linked-worktree test: `git worktree add -b` on a repo
  with zero commits dies `Not a valid object name HEAD` — new-enough git
  (the dev machine's 2.53) tolerates an unborn HEAD, the distro git on a
  stock VM does not. The fixture only runs `git init`.
- 2× `stacks.test.ts` rebase tests: `mergeChain({method:'rebase'})`
  returns `merged: []` — the `--rebase` path shelles
  `git cherry-pick --empty=drop`, a flag old distro gits do not parse
  (usage error → the merge reports "rebase onto main failed").
- `loop.e2e` assertion: fixtures still read ambient git
  config/identity through paths the env scrub misses.
- `loop.test` (`resolveBeadsDir`): the `bd --version` skip probe passes
  on a bd built without CGO/dolt, then `bd init` fails mid-test — the
  probe proves "binary runs", not "store works".

Second problem: `loop.e2e` runs ~35 spawned `bro loop` processes whose
poll cadences are hard floors — `WORKER_POLL_MS = 1_000` per worker
service tick and `--interval` clamped to ≥ 1 s. Every land-shaped test
pays ≥ 1 real second of sleep; the suite totals ~1–3.5 min depending on
host speed.

## Design

**Hermetic git fixtures** — the test seam already scrubs env
(`testkit.ts` / `testrepo.ts`); what is missing is *content*, not env:

- Every fixture repo that a test later `worktree add`s or merges inside
  gets an initial commit — unborn-HEAD worktrees are a git-version
  dice-roll. Identity travels with the commit call itself
  (`-c user.email/-c user.name -c commit.gpgsign=false`), so no config
  file is needed and the fixture cannot read a host `~/.gitconfig` even
  by accident (the pins already nulled it).
- `mergeChain --rebase` stops depending on `cherry-pick --empty=drop`:
  filter the replay set through `git cherry <trunk> <branch>` (the
  patch-id equivalence check the flag wraps, available since ancient
  git) and pick only the `+` commits, oldest-first. Semantics:
  patch-identical members drop exactly as `--empty=drop` dropped them;
  a pick that goes empty mid-range surfaces as the same
  "resolve by hand" failure line it does today.

**bd capability probe** — the skip condition becomes "bd cannot init a
store", not "bd cannot print a version": a scratch `bd init --stealth`
is the probe, failure → `t.skip('bd cannot init — …')`. A real init
failure on a healthy bd still fails the test.

**Test-clock for the spawned CLI** — a subprocess cannot share an
injected `Clock`; the honest e2e lever is the run's own cadence. The
loop poll stack gets a single "tick" the operator can shrink:

- `--interval` accepts fractional seconds — floor is the shared
  `MIN_INTERVAL_SEC = 0.1` every poll-shaped flag already enforces
  (still a poll, never a spin). `--interval 0.1` is the e2e's fake
  clock: every interval-derived wait (gate repoll, push-hold,
  disk-hold) scales down together.
- `WORKER_POLL_MS` becomes `min(1000, intervalMs)` — a fast-ticking run
  services worker exits at its own cadence instead of paying a full
  second per local `.exit` read. Production cadence unchanged at the
  default 60 s interval (worker poll stays 1 s).
- Drive polls (`--every`) accept the same fractional floor so drive e2e
  runs get the same lever where they already script `--every`.

## Non-goals

- No injected `Date.now()` mock in the CLI — deadlines
  (mergeTimeoutMin, stallMin, crashExitMs) stay wall-clock; the e2e
  tests that exercise them already script states the first poll sees.
- No test-runner parallelism rework in this pass; the cadence cut is
  the budgeted fix. If the suite still misses the <15 s bar on a fast
  box, `describe`-level concurrency is the follow-up.

## Plan

- [x] `testkit.ts`: `testRepoInit(dir)` helper — init + first commit
  with inline `-c` identity/signing pins (no config files touched).
- [x] `notify.test.ts`: `withRepo` gains the initial commit — the
  worktree test stops being version-dependent.
- [x] `stacks.ts`: rebase path replays `git cherry`-filtered commits —
  no `--empty` flag on the wire.
- [x] `testrepo.ts`: `bdStoreBlocker()` capability probe; `loop.test.ts`
  skips on "cannot init" not "no binary".
- [x] `loop.ts`: fractional `--interval` (floor `MIN_INTERVAL_SEC`),
  worker poll `min(1 s, interval)`, heartbeat floor 2 s; e2e `f.run`
  defaults `--interval 0.1`.
- [x] `drive.ts`: `--every` accepts the same fractional floor (already
  enforced; the state-cache ttl now caps at the run's cadence).
- [ ] Re-run: `npm test` green under a scrubbed env (empty HOME, no bd
  on PATH); `loop.e2e` suite < 15 s.

## Verify

- `tsx --test packages/cli/src/commands/loop.e2e.test.ts` — suite
  duration drops under the bar.
- `env HOME=<empty> PATH=<no bd> npm test` — the five reviewed failures
  cannot recur: no unborn-HEAD `worktree add`, no `--empty` flag,
  `bd` tests skip by capability.
- `npm run typecheck`, `npm test` full suite green (CI parity).
