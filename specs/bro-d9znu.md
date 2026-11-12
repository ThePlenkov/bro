# bro-d9znu — tmp leak: dead-pid `tmp-*` dirs + stale `bro-published-*` fill /tmp tmpfs

## Problem

`/tmp` is a 5.9G tmpfs; on 2026-11-11 it hit 100% and the loop's disk
floor (bro-2spp7) held every push. Manual sweep reclaimed ~3.7G. Two
distinct creators, two distinct leak shapes:

### `tmp-<pid>-<12rand>` dirs, ~73M each — nx daemon's `nx@latest` probe install

Every live example's package.json is `{"devDependencies":{"nx":"^24.0.6"}}`
— a full `npm install nx@latest`. The name shape is the `tmp` npm
package's `dirSync()` default (`tmp-<process.pid>-<12 random chars>`),
and the embedded pid is the **nx daemon's own pid** (verified against
`/proc`: every live `tmp-*` dir maps to a running
`nx/dist/src/daemon/server/start.js`).

The chain, all inside `node_modules/nx`:

- `daemon/server/latest-nx.js` — `getLatestNxTmpPath()` calls
  `installPackageToTmpAsync('nx', 'latest', pm)` once per daemon
  lifetime and caches the path in module state.
- `utils/package-json.js` — `installPackageToTmpAsync` →
  `preparePackageInstallation` → `createTempNpmDirectory()` →
  `tmp.dirSync()` = `/tmp/tmp-<daemonPid>-<rand>`, then
  `npm install nx@latest --legacy-peer-deps --ignore-scripts`.
- Two daemon handlers reach it: `handle-configure-ai-agents.js`
  (`computeAgentStatuses`, fired by `getConfigureAiAgentsStatus`) and
  `nx-console-operations.js` (`getNxConsoleStatus`,
  `handleNxConsolePreferenceAndInstall`).
- The client side fires the first one after **every non-CI `nx run*`**:
  `tasks-runner/run-command.js` `printConfigureAiAgentsDisclaimer()` →
  `daemonClient.getConfigureAiAgentsStatus()`.

`cleanupLatestNx()` removes the dir — but only on **graceful daemon
shutdown**. bro's own nx-kill reaper (work.ts), OOM, SIGKILL, and crashes
all skip it: the dir is orphaned forever, and because the creator is
dead nothing will ever clean it. ~39 dead-pid dirs ≈ 2.8G accumulated
in days. This is nx's bug, not ours — we cannot patch `node_modules`;
the levers are prevention (`NX_USE_LOCAL=true` skips the latest-install
but is an nx-internal flag read in the daemon's spawn-time env, so it
cannot be relied on for daemons spawned by bare `npm run build`) and
reaping.

### `bro-published-*` dirs, ~106M each — our own publish-surface probe

`scripts/published-surface.ts:110` — `NpmSpec.install()` does
`mkdtempSync(join(tmpdir(), 'bro-published-'))` then
`npm i -g --prefix <dir>/prefix @broject/bro@<version>` (~106M of
package + deps). The `Install` class records `dir`/`scratch` and has
**no cleanup path**: `gen-published.ts` (`npm run check:published`,
`gen:published`) and `check-onboarding.ts` (`check:onboarding`) both
probe once and exit — several exits are `process.exit(1)`, which runs
no `finally`. Every CI/manual run leaks one dir.

## What already exists

`bro cleanup` → `cleanupTmpDirs` (cleanup.ts) sweeps `tmp-*`, `npm-*`,
`npx-*`, `node-*` in `os.tmpdir()`: current-uid dirs older than 1h
(`STALE_MS`) that no `/proc/*/fd|cwd|root|exe` link touches
(`isPathInUse`). In theory it would catch the dead-pid nx dirs — but
(a) it is a manual command nobody runs on a cadence, (b) its pattern
list does not include `bro-published-*`, and (c) `isPathInUse` is
broken on multi-user hosts (below), so it has never actually deleted
anything here.

The loop's disk floor already *detects* the full tmpfs and holds work —
the missing half is reaping, not detection.

## Design

Two fixes, matching the two leak classes: stop our own leak at the
source; extend the existing sweeper for the third-party one and give it
a periodic caller.

### 1. `scripts/published-surface.ts` — dispose the install fixture

- `Install` gains `dispose()` (`rmSync(dir, {recursive, force})`) and
  registers a `process.on('exit')` handler in its constructor that does
  the same synchronously. The exit hook is the load-bearing half:
  `check-onboarding.ts`/`gen-published.ts` reach `process.exit(1)` on
  failure paths where `try/finally` never runs.
- `NpmSpec.install()` wraps the post-`mkdtempSync` body (npm install +
  `new Install`) in try/catch → `rmSync(dir)` + rethrow, covering the
  window before the exit hook exists (npm failure, missing `bin/bro`,
  scratch `mkdtempSync` failure).
- `scratch-*` lives inside `dir`, so one recursive rm covers the whole
  fixture.

### 2. `cleanupTmpDirs` — broader patterns + owner-liveness verdict

The sweep machinery moves to `packages/cli/src/commands/tmp-sweep.ts`
(`isPathInUse` and friends reworked — see §3) so `work.ts` can call it
without a `work.ts ↔ cleanup.ts` import cycle (`cleanup.ts` already
imports `isAncestor` from `work.ts`). `cleanup.ts` keeps
`runCleanupCommand` and imports `cleanupTmpDirs` back — `bro cleanup`
behavior is unchanged except the wider net.

Target patterns gain `bro-published-` (prefix match, same class as the
rest). The per-entry decision becomes a pure exported predicate
(`tmpSweepVerdict`) so the rule is unit testable without touching
`/tmp` or `/proc`:

- **`tmp-<pid>-*` names are governed by owner liveness, not the TTL.**
  The pid in the name is the creator's; on ptrace_scope≥1 hosts the
  /proc scan can only inspect our own descendants' fd tables, so a
  live owner's temp dir (an nx daemon's `nx@latest` install) reads
  unverifiable — TTL+scan would delete it out from under the owner.
  Alive owner → keep (its temp dir is its own business until it
  exits); dead owner → delete once past `DEAD_OWNER_GRACE_MS` (10min,
  a grace against path-passing races) plus the usual not-in-use check.
- **Pid-less patterns** (`bro-published-*`, `npm-*`, `npx-*`,
  `node-*`, mkdtemp `tmp-XXXXXX`) keep the original contract: 1h
  `STALE_MS` + not-in-use.

`cleanupTmpDirs(dryRun, { quietKeeps })` — `quietKeeps` suppresses the
per-dir `keep` lines (they are the noise floor when a supervisor relays
child output); `deleted`/`would delete`/summary lines still print.

### 3. `isPathInUse` was a no-op on any multi-user host — the sweep never deleted anything

The deeper reason the leak refilled: `processUsesPath` returns
`'unverifiable'` when `/proc/<pid>/fd` cannot be listed — which is
**every foreign-uid process** (52 of 114 pids on this box: root
snapfuse/systemd/cups daemons) *and* same-uid non-descendant session
procs under yama `ptrace_scope=1` (`systemd --user`, `(sd-pam)` —
fd tables of non-descendants are unreadable even at the same uid).
`isPathInUse` treated `unverifiable` as in-use, so the sweep answered
"in use" for EVERY candidate and `bro cleanup` deleted nothing, ever.
Verified live: a fresh probe dir reads in-use purely from unreadable
fd tables.

Fix inside `isPathInUse`, two parts:

- **Foreign-uid pids are skipped for uid-private candidates.** The
  dirs this sweep targets are mode 0700 (`tmp` package `DIR_MODE`,
  `mkdtempSync`), so a foreign process cannot legitimately sit inside
  one — its unreadable fd table is not evidence of use. The pid's
  owner uid is read from the world-readable `/proc/<pid>` dir
  metadata. A group/other-accessible dir keeps the old conservative
  answer: a foreign process could legitimately be inside, and we
  cannot inspect it → keep.
- **`'unverifiable'` only blocks on accessible dirs.** For a 0700
  candidate, an unverifiable (non-descendant, non-dumpable) process
  has no legitimate claim — counting it kept everything forever. On
  group/other-accessible dirs it still keeps, since a process we
  cannot inspect could genuinely be inside. Positive `'use'` evidence
  (fd/cwd/root/exe link resolving inside the candidate — always
  visible for our own descendants) still keeps unconditionally.

### 4. `bro work prune` — the periodic caller

`drive`'s `litterSweep` already spawns `bro work prune --loop` in a
child on the `drive.litterSweepSec` cadence (default 3600s) — the
existing periodic-maintenance hook, no new daemon. `cmdPrune` calls
`cleanupTmpDirs(dryRun, { quietKeeps: true })` right after
`pruneStaleEntries()`, for plain and `--loop` invocations alike: hourly
automatic reaping of dead-owner dirs, and `bro cleanup` stays the
explicit command. A sweep failure warns, never aborts the prune.

`NX_USE_LOCAL=true` was evaluated and rejected as the primary fix: it
is an nx-internal dev flag read from the daemon's spawn-time
environment, so it cannot reach daemons spawned by bare `npm run
build`/`nx` invocations outside bro's control, and it changes migrate/
init semantics well beyond this leak.

## Tests

- `tmp-sweep.test.ts` (new, beside cleanup.test.ts): the pure predicate
  — dead-pid `tmp-*` inside grace → skip, past grace → delete (or keep
  when in-use); live-pid `tmp-*` → keep at ANY age (owner liveness is
  the use signal the blind scan cannot provide); pid-less `tmp-XXXXXX`
  → TTL only; `bro-published-*`/`npm-*`/`npx-*`/`node-*` → TTL;
  foreign-uid → skip; in-use → keep; non-dir → skip. `isPathInUse`
  against a live `sleep` child cwd (positive) and a fresh dir
  (negative — this is the assertion that fails on the old
  unverifiable-poisoned code). Plus a `TMPDIR`-overridden
  `cleanupTmpDirs` integration pass creating real 0700 fixture dirs
  (dead pid = a just-exited child, live pid = `process.pid`) asserting
  delete/keep outcomes, the `owner pid alive` keep reason, and
  `--dry-run`.
- `cleanup.test.ts`: unchanged plan tests; the degrade-path tests keep
  passing (sweep now runs inside `runCleanupCommand` as before, wider
  net only).
- `published-surface`: no unit harness exists for the scripts (they are
  CI-only npm probes); the dispose path is exercised by
  `npm run check:published`/`check:onboarding` themselves — verify by
  running one and asserting no `bro-published-*` dir remains.

## Verify

`npm run build`, `npm run typecheck`, `npm test` (cli package), Biome on
touched files. Manual: `ls -d /tmp/bro-published-*` before/after a
`check:published` run; `bro work prune --dry-run` output sanity.
