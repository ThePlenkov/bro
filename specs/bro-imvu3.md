# bro-imvu3 — worktree reaper blind spot: widen litter candidate selection

## Problem

`reapLoopLitter` — the fail-closed sweep behind `bro work prune --loop`,
the loop close-out audit, and the drive daemon's `litterSweepSec` tick —
only sees `loop/<slug>` and `stack/<…>` branches. Its candidate
predicate is prefix-scoped at two points:

- `litterSlug` (work.ts) maps only `loop/` and the configured
  `stackPrefix` onto a bead slug; every other branch returns
  `undefined` and is skipped.
- `litterCandidates` additionally drops any worktree with
  `w.branch === undefined` — detached HEAD is invisible.

Forensic sweep 2026-11-11: 19 merged-PR worktrees (~16GB) accumulated
under `<repo>--*` on `work/` branches and detached HEADs. `bro work
enter` trees live on `work/<slug>`; drive fixers and ad-hoc heads land
on `work/`/`feat/`/`fix/`/`devin/`. ALL of them sit outside the sweep —
`work prune --loop --dry-run` post-sweep reported "0 would be reaped".

The machinery to do better already exists and is tested:
`removeMergedWorktree` (locked/live-process/clean guards) and the
claim-liveness planes (`claimOwner` → runRecord/registry/session/watch/
treeProcess owners) implement merged-PR evidence, open-bead veto,
live-process veto, and nx-daemon pre-kill. The gap is ONLY candidate
selection.

## Decision: option (a) — widen candidate selection, reuse every guard

The bead offers (a) widen prefixes + detached HEAD, (b) bro-8uzd6's
bead-CLOSED+empty-diff reaper, (c) both. This spec takes **(a)**:

- The reported leak is merged-PR trees on known branch namespaces —
  (a) reaps exactly that class through the existing verdicts.
- (b) is a different reaper (grace windows, gone-since stamps, backup
  push to origin, herdr-workspace checks, empty-diff computation) — a
  feature-sized change that deserves its own spec/PR. It stays open on
  bro-8uzd6; the widened candidate set this spec adds is the natural
  substrate it would consume later.
- Every guard (a) needs is already in place and e2e-tested; widening
  selection cannot weaken them — candidates flow through the same
  `litterDoneVerdict` → `litterTreeVerdict` → `removeMergedWorktree` →
  `retireLitterBranch` path as `loop/` litter does today.

## Design

### 1. Candidate namespaces

`litterSlug` grows a second return shape. Deterministic namespaces
(`loop/`, `stack/…`) keep verbatim slug extraction. A new label
namespace — `work/`, `feat/`, `fix/`, `devin/` — returns the branch
tail as `slug` plus `label: true`: the tail is a human/agent label,
not a bead contract, so bead resolution goes through matching (below)
instead of the exact map read alone. A merged PR's headRef is the land
proof for these branches either way — `litterPrEvidence` is
branch-keyed and needs no bead at all.

`litterBranches` sweeps the same prefixes for bare (worktree-less)
branches — a merged `work/foo` ref is the same litter class as a
merged `loop/foo` one. `onTree` now also excludes the main
worktree's own branch: a `fix/…`/`feat/…` main checkout must never
read as bare litter.

### 2. Detached HEAD candidates

A detached worktree has no branch — two slug sources, in order:

1. **Tip attribution** — one `for-each-ref` over `refs/heads/` per
   sweep (built lazily on the first detached entry, filtered to
   candidate-eligible branches). When exactly ONE eligible branch tip
   equals `w.head`, the candidate takes that branch wholesale: slug,
   label flag, PR evidence, and branch retire all behave as if the
   tree were checked out on it. Zero or multiple matches → unattributed.
2. **Dir/claim slug** — unattributed detached trees fall back to the
   in-tree claim marker detail (`<gitdir>/bro/work`, the enter-time
   record) then the `<main>--<slug>` sibling-dir convention. Neither
   present → not litter-shaped, skipped silently.

An unattributed detached candidate carries `branch: ''`: PR evidence
is skipped (no branch to ask about — `{known, open:false}`, never a
lookup failure), `retireLitterBranch` no-ops, and the reap report
reads `(detached)` instead of `[]`. Its done verdict is therefore
bead-CLOSED-only — merged-PR evidence requires the attribution leg.

### 3. Label bead resolution (`litterBead`)

`bySlug` stays `loopSlug(id) → row`. Lookups become a ladder:

1. Exact `bySlug.get(c.slug)` — deterministic namespaces and tidy
   `work/<bead-id>` names hit here.
2. Label candidates only: `beadForHead` (`@broject/loop`, the
   fleet-head reconcile's own matcher) over the candidate's branch —
   `-`-bounded prefix match (`work/<bead>-desc` → `<bead>`), longest
   slug wins, two distinct bead owners → undefined (ambiguous = keep).
3. Label candidates only + store prefix (`tasks.prefix()`, best-effort
   — probe failure just skips this rung): the same matcher on the
   `<prefix>-<slug>` form, so `work/imvu3` resolves `bro-imvu3`.

Unresolved → `undefined` → the existing "no bead — unverifiable"
keep. Resolution NEVER widens a verdict: it only lets the same
closed/in_progress checks see the bead that was always there.

`sessionOwner` additionally matches live `.work`/`.task` marker
details against the resolved `bead.id`/`loopSlug(bead.id)` — a
`.task` marker armed by `bd update <bead> --claim` carries the full
id, which the branch/slug/worktree match alone misses for short
slugs. Every other claim-liveness plane is already bead- or
path-keyed and works unchanged.

### 4. Guards — reused verbatim, never rebuilt

Candidates flow through the identical verdict chain as today:

- `litterDoneVerdict` — bead closed OR merged-PR head; PR lookup must
  be known; open PR vetoes.
- `releaseDeadClaim`/`claimOwner` — in_progress beads release only
  when every liveness plane is dead (run records, registry, session
  markers, act watches, /proc).
- `litterTreeVerdict` under the agent-registry lock — locked,
  registry occupant, live in-tree claim marker, dirty porcelain.
- `removeMergedWorktree` — locked, `processesRootedIn` (live cwd or
  argv inside the tree), clean `status --porcelain` with untracked
  files forced visible, `worktree remove --force`.
- `retireLitterBranch` — merged-PR head pin via
  `deleteMergedLocalBranch`, else git's own `branch -d` merged check;
  `''` branch (unattributed detached) skips.
- `reapStaleNxDaemons` — now also scans the widened trees, so stale
  nx daemons pinning `work/` trees get the same pre-kill.
- Parked pool — open-bead label trees join the same
  `parkedKeep`/`parkedTtlDays` resume-cache bound as loop litter.

`ghostBranch` gains `feat/`/`fix/`/`devin/` bindings so recovered
`<main>--<slug>` ghosts can re-register onto those branches too
(`loop/`/`work/`/`stack/` already covered).

## Out of scope

- bro-8uzd6's bead-CLOSED+empty-diff reaper (grace window, backup
  push, herdr checks) — separate feature, stays open.
- `backup/`, `pr-*`, `temp-*`, `worktree/` (herdr) and other foreign
  prefixes — not litter namespaces; untouched.
- Remote-tracking refs — attribution and PR evidence read local
  `refs/heads/` only, same as today.

## Plan

- [x] `litterSlug` → `{slug, label}`; add `LITTER_LABEL_PREFIXES`.
- [x] `litterCandidates` — detached HEAD path (tip attribution +
      dir/claim slug), `onTree` += main branch, `litterBranches`
      prefix widening, `ghostBranch` prefix widening.
- [x] `litterBead` ladder + `ctx.prefix`; rewire `litterDoneVerdict`,
      `reapCandidate`, `releaseOrphanedRuns`, `sessionOwner`.
- [x] `litterPrEvidence`/`retireLitterBranch` `''`-branch guards;
      `(detached)` reap label.
- [x] e2e coverage: each new prefix, detached (attributed +
      unattributed), veto paths (open PR, dirty, locked, live
      process, open bead, ambiguous slug).
- [x] `npm run build`, `npm run typecheck`, `npm test` (cli package).
