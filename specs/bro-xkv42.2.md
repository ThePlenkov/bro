# bro-xkv42.2 — exit-time learn/retro artifact check: no silent worker exits

Parent: `bro-xkv42` (every worker session ends with learn + retro). Sibling
`bro-xkv42.1` owns the closeout-contract wording in spawn prompts; this bead
owns the enforcement half — a worker that exits without qualifying
learn/retro evidence is flagged at exit harvest, never silently clean.

## Problem

A detached worker's exit is already harvested once per run:
`ensureExitCause` folds the `.exit` record + log/stderr tails into a
classified `cause` on the registry entry and emits the `agent-exit`
lifecycle row. Nothing in that path asks whether the run left the learn
artifact the epic requires — a worker can exit `ok` having produced no
lesson, no flagged molecule result, and no retro bead, and every surface
(status, fleet, loop audit, lifecycle journal) reports a clean exit.

The check must run inside that same once-per-run harvest: it is the only
point every local backend's death already funnels through, it fires
exactly once per run (the carried-`cause` early return dedupes repeat
polls), and it is hook-independent — detached workers have no Stop hook
to gate on.

## Design choice — A vs B vs C

**A — artifact check at exit harvest (chosen).** Deterministic, runs on
every local worker exit, reads only the shared store the worker itself
was pinned to (`BEADS_DIR`). Cost is a handful of bounded `bd` calls once
per run, never per poll. It composes with `bro-xkv42.1`'s prompt contract
but does not depend on it landing first — evidence is checked, not
promised.

**B — stop-gate aspect (rejected for this PR).** A hook-side gate only
sees interactive sessions; detached workers die by process exit, not by
a Stop event, so the gate would cover the smallest slice of the fleet
and miss exactly the workers the epic targets. It also couples the
enforcement to prompt/hook plumbing (`bro-xkv42.1`, `bro-xkv42.4`) that
is still in flight. Recorded here as the follow-up surface if a harder
block is ever wanted; this bead ships detection + flagging only.

**C — retro/prevention beads as the only evidence (rejected).** Most
runs produce lessons, not retros; requiring a retro bead would flag
honest learn-producing runs. The three evidence kinds below are
alternatives, not a conjunction.

## Evidence contract

The check resolves a verdict per run — `ok` | `miss` | `skipped` —
persisted on the registry entry (`learnCheck`, `learnEvidence`).

**Skip gates (never a miss):**

- `cause` ∈ `rate_limited | quota | auth` — a provider/budget wall means
  the worker was prevented from doing useful work; absence of evidence
  proves nothing (the bead's budget-wall exclusion, extended to `auth`
  which is the same class of "could not work").
- `entry.stopped` — an operator-ended run (`agents down`) never reached
  its closeout; externally prevented like a wall. The status path
  returns `stopped` before classify, so this only covers the
  unconditional harvest callers (budget walks).
- `backend` ∈ remote lanes (`copilot`) — the remote worker can never
  reach the shared dolt, so its artifacts are uninspectable by
  construction; flagging it would be a false positive by design.
- Any probe failure — an unreadable store or a drifted `bd` payload
  degrades the verdict to `skipped` with the failing plane named,
  never a `miss` on unproven absence.

**Pass evidence (any one → `ok`, first hit wins):**

1. **Flagged result** — a `learn:`/`learning:`-prefixed line (the same
   `LEARN_FLAG` contract `capture:mol` harvests) in the close_reason of
   the run's bead; for molecule-*root* runs (convoy runners), any step's
   close_reason via one `bd mol show`. The bead's own `closed_at` (when
   present) must sit inside the run window so a respawn doesn't inherit
   a prior attempt's flag.
2. **Lesson evidence** — a `learn/` kv lesson whose `evidence[].ref`
   intersects the run's id set (agentId, runId, `session_id`,
   `acpSessionId`, molStep, molecule parent, molecule step ids) and
   whose `updatedAt ?? createdAt` sits inside the run window. The kv
   listing rides a stamp-keyed snapshot cache (`beadsStoreStamp`) like
   the connector's lesson snapshot — issue writes over-invalidate,
   which is safe.
3. **Retro artifact** — a `retro`/`prevention`-labeled bead reachable
   over `discovered-from` edges *up* from the run's beads, walked at
   most two hops (run bead → wtf → retro covers the canonical
   `wtf`/`record` chain), with the discovered row's `created_at` inside
   the run window when the field parses. Fallback: `retro`/`prevention`
   rows *created* inside the window — `captureWtf` wires no dep to the
   work bead, so creation time is the only attribution the standard
   flow leaves; the evidence string names it as window-attributed.

The run window is `[spawnedAt − 120s, exitAt + 300s]` — `exitAt` is the
`.exit` file's mtime (the honest death stamp), so a lazy harvest hours
later still windows on the death, not the read.

**Otherwise → `miss`.**

## Mechanics

- `packages/cli/src/agent-connectors/learn-evidence.ts` (new) —
  `checkRunLearnEvidence({dir, molStep, entry, cause, exitAt})` returns
  `{verdict, evidence?}`; every probe is individually fail-open and a
  failure marks the verdict `skipped`, never `miss`. The store read is
  the run's *pinned* store: `commitSpawn` persists `spec.beadsDir` as
  `entry.storeDir` and the check prefers it over `beadsDir(dir)`, so a
  `--beads-dir` or env-pinned spawn is verified where its worker
  actually wrote; pre-`storeDir` entries fall back to `beadsDir(dir)`.
  The lesson-snapshot stamp (`beadsStoreStampAt`) keys the same resolved
  path — a stamp on the wrong store would serve another store's
  lessons.
- `@broject/learn` gains `listLessonsAt(beadsDir)` (the `bdAt`-pinned
  twin of `listLessons` — exit harvest reads the *shared* store, not
  cwd-discovered) and exports `LEARN_FLAG` so the flag regex has one
  source.
- `ensureExitCause` runs the check inside the once-per-run classify
  block, after `emitClassifiedExitLifecycle`; a `miss` additionally
  emits a `learn-miss` lifecycle row (new `LIFECYCLE_KINDS` member —
  journal-only, no bus mapping: it is an audit annotation, not a
  worker state transition). `persistClassifiedExit` carries
  `learnCheck`/`learnEvidence` onto the registry row, and `commitSpawn`
  clears both on respawn like `cause`/`resetAt`.
- `AgentInfo`/`AgentRegistryEntry` gain `learnCheck`/`learnEvidence`;
  every backend's `toInfo` maps them via one helper. `bro agents
  status` gains a `learn` table column + targeted detail line; `bro
  fleet`'s agent cell marks `exited — learn-miss`; the loop's end audit
  gains a `learn misses` named tail over registry entries whose step
  the run saw.

## Cost

Once per run, never per poll: ~4–7 `bd` calls worst case on the full
miss path (`show` + optional `mol show` + cached-or-live `kv list` +
`dep list`/`show` + two label `list`s), each early-exiting on the first
hit, each bounded by `bdAt`'s timeout. The lesson kv read is the only
repeated one and rides the store-stamp snapshot.

## Verify

- `learn-evidence.test.ts` — fake-bd fixtures: miss on a clean exit,
  `ok` via each evidence kind, `skipped` on wall causes/remote
  backend/unreachable store, window enforcement, dep-walk depth.
- `agent-connectors.test.ts` — an `ok` exit with no evidence lands
  `learnCheck: 'miss'` + a `learn-miss` journal row; evidence present
  stays silent.
- `npm run build`, `npm run typecheck`, package tests, `check:*` gates.
