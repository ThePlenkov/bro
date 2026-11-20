# bro-v96mp — worker tmp litter: pin TMPDIR into the worktree git dir

## Problem

`/tmp` is a 5.9G tmpfs. While acp-workers ran, `tmp-<pid>-<rand>` dirs
(~73M each — an nx daemon's `npm install nx@latest` probe, spec
bro-d9znu) appeared every few minutes: one per worktree's nx daemon.
Workers killed by a provider rate limit (SIGKILL) cannot run teardown,
the nx daemon's `cleanupLatestNx()` runs only on graceful shutdown,
and a live daemon's dir is a legitimate keep — so the litter outpaced
the hourly `work prune` sweep: 49 dirs ≈ 3.4G, /tmp at 92%, the loop's
disk floor (2×400M) held every push.

bro-d9znu fixed the *reaper* (dead-owner verdicts, `bro-published-*`
dispose, hourly cadence). This bead is the *source*: the litter should
never land on the tmpfs at all.

## Design

### 1. Connector pins the worker's TMPDIR into its own git dir

`workerTmpDir(repoRoot, agentId)` = `<worktreeGitDir>/bro-tmp/<agentId>`
(`worktreeGitDir` = `<common>/worktrees/<n>` on a linked worktree,
`<repo>/.git` on the main checkout). The native backend sets
`TMPDIR`/`TMP`/`TEMP` in the spawned env; the tmux backend sends the
same pins as `-e` flags (its ambient env file drops them via
`AGENT_PIN_KEYS`). `mkdirSync(dir, {mode:0o700})` runs inside the
spawn guard — mkdtemp needs the parent.

Why here and not in the working tree: a tmpdir in the checkout is a
dirty file the agent could commit and `worktree remove` refuses dirty
trees. The git dir is invisible to `git status`, and `git worktree
remove` deletes the whole admin dir — so the litter dies with the
worktree the reaper was already removing. Nothing new needs to reap
the common case.

`TMPDIR`/`TMP`/`TEMP` join `AGENT_PIN_KEYS`: ambient and spec.env
copies are stripped on every backend the way identity pins are — a
caller-supplied TMPDIR would re-aim the leak at the tmpfs. Docker is
unaffected (`DOCKER_HOST_ENV` already dropped them; a container's /tmp
is not the host's).

What this covers: the worker process and everything it spawns — the
agent CLI, `npm test`/`npm run build`, the nx daemon those start, the
daemon's `tmp.dirSync()` latest-nx install. What it does not: nx
daemons spawned by commands bro runs under its own env outside the
worker (the main checkout's own daemon — a single ~73M resident the
hourly sweep already governs by owner liveness).

### 2. The sweep follows the pin

`cleanupTmpDirs` gains `opts.extraRoots` — additional sweep roots under
the same verdict (owner liveness for `tmp-<pid>-*`, TTL+in-use
otherwise). `workerTmpRoots(dir)` resolves them:
`<common>/bro-tmp/<agentId>` (main checkout) plus
`<common>/worktrees/*/bro-tmp/<agentId>` (linked worktrees whose admin
dirs outlive a manual rm). An emptied root is `rmdir`'d with its
contents; an unlistable root warns and skips, never fatal. `bro work
prune` and `bro cleanup` both pass `workerTmpRoots(cwd)`.

### 3. The disk floor alarms earlier and names the filler

`DiskProbe` gains `totalBytes` (statfs `blocks×bsize`). `diskFloorFor`
gives the effective floor: the slot price normally, but a filesystem
the queue could never grow into (`total ≤ 16 × slot floor` — a tmpfs)
demands proportional headroom: **half stays free**. On the 5.9G tmpfs
the floor moves from 800M (86% used) to 2.95G (50% used) — the
acceptance threshold itself.

On the breach edge (once per episode, same rule as the held line) the
loop walks the breached path top-level with a bounded budget and says
the top consumers prefix-grouped: `loop: disk below floor on /tmp —
705M free < 2950M floor — top: tmp-* ×47 3.3G — pushes held`. The
summary rides `ctx.q.diskFiller` into the heartbeat:
`idle (disk floor — tmp-* ×47 3.3G)`. `topFillers` caps at 60k
nodes/1.5s — a breach edge must not stall the tick on a huge tree;
truncation marks `…`.

## Tests

- `capacity.test.ts`: the small-fs leg — total/2 floor on a 5.9G fs,
  slot price when it is the bigger floor, big fs keeps slot pricing,
  absent totalBytes unchanged.
- `tmp-sweep.test.ts`: `extraRoots` sweeps by the same verdicts
  (dead-owner leaf reaped, live-owner kept, emptied root rmdir'd);
  `workerTmpRoots` lists main+linked roots and answers [] off-repo.
- `agent-connectors.test.ts`: native spawn env — `TMPDIR`/`TMP`/`TEMP`
  pin `<gitdir>/bro-tmp/<agentId>` (0700), ambient+spec.env overrides
  lose, the pin lands under strictEnv.
- `loop.test.ts` (rig): `topFillers` prefix-grouping, nested sizes,
  top-3 + `+more`, truncation mark, unlistable root → ''.
- `loop.e2e.test.ts`: the disk-floor hold test's heartbeat regex now
  tolerates the filler suffix.

## Acceptance

- A killed-by-rate-limit worker leaves no `/tmp/tmp-*` behind — the
  litter lands under `<worktree gitdir>/bro-tmp/` and dies with
  `git worktree remove`.
- `/tmp` stays <50% during a cap-2 run — nothing worker-owned writes
  there, and the floor holds at 50% used regardless.
