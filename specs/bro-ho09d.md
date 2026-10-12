# bro-ho09d — release claims + reap worktrees of dead workers

## Problem

A `bro loop` worker dies — SIGKILL, end_turn, host restart — and the
chain of cleanup that should follow never runs: the runItem audit that
would reopen the bead is gone with it (bro-snga4), the bead stays
`in_progress`, and `bro work prune --loop` correctly refuses to reap an
in_progress tree. The worktree lives forever.

Observed live: 13 sibling worktrees, one live worker; seven beads sat
in_progress under dead workers. Each parked tree carries ~346M of
`node_modules`. The claim is only as real as its worker — an
`in_progress` bead with no live worker is an orphan, not a keep.

Three leaks compound:

1. The claim never releases, so the bead can never be re-claimed.
2. The parked-worktree resume cache is unbounded — open beads keep
   trees forever.
3. A directory whose admin entry is gone (`bro--bro-oam4` existed on
   disk with no `git worktree list` row) is invisible to every sweep —
   git's own `worktree prune` only removes admin entries.

## Design

The loop-litter sweep (`bro work prune --loop`, and the identical pass
`bro loop` runs at endAudit) gains claim liveness, a bounded parked
pool, and a ghost sweep. Same entry points, same kept-or-reaped
verdicts — the sweep stays fail-closed: anything unverifiable is a keep.

### 1. Claim liveness planes

An `in_progress` litter bead keeps its claim only while a plane proves
a live owner. Checked planes, cheapest first:

- **Loop run records** (`<git-common>/bro/loop/<slug>.json`) — a record
  whose pid+pidStart is alive owns the claim (and every id in its
  `beadIds` clump list). Written at claim time (below), re-stamped with
  the worker pid at spawn.
- **Agent registry** (`bro/agents.json`) — an entry keyed by the bead id
  or pinned to the candidate's worktree that reads
  running/spawned/blocked (blocked = budget-walled, will respawn — its
  claim is real). An unreadable registry answers "live": a plane that
  can't be read is not a dead worker.
- **Session markers** — live `.work`/`.task` markers in
  `<git-common>/bro/hooks` whose detail matches bead id, branch, slug,
  or worktree.
- **Act watches** (`<git-common>/bro/watches`) — a live wait marker
  whose `bead` matches (comma-joined clump ids included) or whose
  `workdir` is the candidate's tree. A gate-stack member's claim
  survives its worker's exit: the loop still services the gate
  (bro-q6ppv).
- **/proc** — an agent-shaped process cwd'd inside the worktree.

Dead on every plane → **release**: `tasks.note` (why released) +
`tasks.reopen` under the agent-registry lock — the same lock a spawn
holds across its claim→registry write, and the registry is re-read
inside the lock so a respawn landing during the wait still wins. The
bead rejoins `bd ready`; its tree then flows through the normal
verdicts as ordinary open-bead litter. Branches are never touched by a
release — they are the cheap half of the resume cache.

### 2. Loop custody record

The claim→spawn window had no liveness record: `claimClump` claims,
`pushItem` builds the worktree, `runBootstrap` can take minutes, and
only `spawnAgent` used to write `bro/loop/<slug>.json`. A sweep in
that gap would see an orphaned claim that isn't. `claimClump` now
writes the record the moment the claim lands, with `pid` = the loop
process itself — the loop is the claim's custodian until `spawnAgent`
overwrites it with the worker's real pid; a dead loop leaves a
dead-pid record, which is exactly the proof the sweep needs. The
record's `beadIds` carries the whole claimed clump so batch members
trace to the same owner. `pushItem` re-stamps it once the worktree
exists, the bootstrap-failure and worktree-failure early returns end
it, and worker settle retires it — by then the member's act-watch
marker (bead ids riding comma-joined, bro-q6ppv) carries custody
through gate-stack tenure.

### 3. Parked pool — bounded resume cache

An open-bead worktree is a resume cache entry, not a keep — recreated
in ~2min of `npm ci`, held forever at ~346M. The pool is bounded two
ways, both under `loop.*` config:

- `loop.parkedKeep` (default 3, `0` = uncapped) — newest N clean parked
  trees survive; the rest reap.
- `loop.parkedTtlDays` (default 14, `0` = off) — a tree idle past this
  reaps regardless of the cap. Idle reads the newest mtime of the work
  dir itself plus its gitdir's `index`/`logs/HEAD`/`HEAD` — checkout,
  commit, and rebase all refresh it; a dead tree's clock froze with it.

Ordering is newest-first; a dirty, locked, claimed, or occupied tree is
kept outright and never consumes a pool slot — it is data, not cache.
Bare branches stay uncapped (cheap).

### 4. Ghost sweep

Sibling `<main>--*` dirs absent from `git worktree list` are inspected
before candidate enumeration so a recovered ghost re-enters through the
normal verdicts:

- `.git` **file** pointing into `<common>/worktrees/<name>` with that
  admin dir gone → recreate it (`gitdir`, `commondir`, `HEAD` bound to
  the branch the name implies — `loop/<slug>`, `work/<slug>`, else the
  stack member carrying `<slug>`), then `read-tree HEAD` rebuilds the
  index. Re-registered ghosts are reported (`re-registered`) and judged
  like any candidate: closed-bead clean trees reap, open beads park,
  dirty keeps.
- `.git` **directory** (a foreign clone) or a pointer outside this
  repo's admin space → kept and reported, never touched.
- No `.git` at all → kept and reported, unless the dir is empty (an
  empty dir is removal-safe).
- No matching branch to bind `HEAD` to → kept and reported — a ghost
  whose provenance can't be reconstructed is human triage, not a reap.

Under `--dry-run` ghosts are reported as `would re-register`/`would
reap` without mutation.

## Non-goals

- No new kill paths — liveness is `/proc` pid+start identity
  (bro-9lpn3's rule stands: age is advisory, never a kill).
- Branches are kept unless the existing retire path can already delete
  them (merged-PR pin or `branch -d`-able) — claim release never widens
  branch deletion.
- Bare `bro work prune` (no `--loop`) keeps its scope; ghosts and
  claims are litter-sweep business.
- Fixer beads and other non-loop `in_progress` claims aren't swept —
  the planes only run for litter candidates and dead loop-run records.
