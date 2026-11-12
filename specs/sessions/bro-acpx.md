---
parent: sessions
scope:
  - packages/acpx/
  - packages/cli/src/commands/archive.ts
  - packages/cli/src/guard-probes.ts
  - packages/providers/src/acp-proxy.ts
  - packages/acp/session/src/archive/
  - bro.config.json
---

# bro-acpx — session archival: acpx facade + git-linked retention verdict

## Problem

Agent session history grows without bound and nothing owns its
retention. Measured on this host: Devin's `sessions.db` is 7.8 GB,
`opencode.db` 604 MB, `kilo.db` 464 MB, acpx records + event files
accumulate under `~/.acpx/sessions/` — and the obvious prune
(`--older-than N days`) is wrong: a two-month-old session on a dirty
worktree with unpushed commits is *unfinished work*, while
yesterday's session on a merged branch is dead weight. Age is not
the axis; **git state is**.

What decides "may this history leave the store" is the worktree the
session was bound to: dirty files, commits not on the upstream, an
open PR — any of them means the conversation still has a job. bro
already owns that state (`bro work` worktree lifecycle,
`bro cleanup`'s merged-PR intersection over local branches, the
closed guard-probe registry, the archive LED verdict in
`packages/acp/session/src/archive`) and the hook plane to speak up
at the right moment. Missing pieces:

1. a **facade over acpx** — session state is read by shelling the
   acpx CLI and parsing text; nothing can answer a thin client's
   "what's archivable?" without spawning a subprocess;
2. a **retention verdict** fusing git state with session liveness —
   nothing computes it, so nothing can gate export or prune on it;
3. an **ACP surface** for the verdict — the session pane and
   `bro serve` clients can neither see nor trigger archival.

## Design

### 1. bro is a facade over acpx — as a TypeScript dependency

acpx@0.21 publishes `acpx/runtime` (`createSharedAcpRuntime`,
`findSession`, `watchSession`, `close`, …) — the same session store
and queue owners the CLI uses. bro takes it as a real npm dependency
in a new `packages/acpx`, so `zod`/`commander`/`tsx` land only where
the facade is used; the root already dedupes
`@agentclientprotocol/sdk` to a single ^1.9 copy, satisfying both
bro's ^1.7 range and acpx's ^1.9.

- **reads + lifecycle** → the runtime API in-process: `findSession`
  (no agent launch), status, watch, soft-close;
- **export / import / prune** → the acpx CLI with `--format json`
  (documented JSON shapes; the runtime exposes no archive surface
  yet). The CLI wraps behind one module so the seam moves if acpx
  grows runtime equivalents.

No text parsing anywhere: every CLI leg is `--format json`.

### 2. The retention verdict — git state ∧ session liveness

```ts
archivable(s) = gitClean(s.worktree)
             ∧ ¬unpushed(s.worktree)
             ∧ ¬prOpen(s.worktree)
             ∧ ¬sessionActive(s)
```

- `gitClean` — `git status --porcelain`, the memoized read the
  guard probes already share (one porcelain per sweep);
- `unpushed` — `git log @{u}..HEAD` empty; **no upstream counts as
  unpushed** (never delete what has no remote copy);
- `prOpen` — review-host open PR for the worktree's branch, the
  same facade `bro cleanup` queries for merged state;
- `sessionActive` — acpx `status` (`running` → active; `idle`/
  `dead` → not) for acpx sessions; the archive LED
  (`rowVerdict`/`eventsVerdict`) for bro-managed fleet sessions —
  `working`/`blocked` are active, `idle` is not.

Fail-closed, like every guard probe: a leg that can't verify (no
upstream, review host unreachable, status error) yields **not
archivable** — a predicate that can't verify doesn't assert, and
here the assertion is a deletion.

### 3. Commands — `bro archive`

```text
bro archive status [session]   # session × verdict table; blocked rows
                               # name their reason (dirty/unpushed/pr/
                               # active); exit 1 if anything blocked —
                               # CI-able, `bro spec check` shape
bro archive run [--dry-run]    # export every archivable session via
                               # acpx export + write the git sidecar
bro archive prune [--dry-run]  # delete ONLY sessions with a completed
                               # export + sidecar — no archive, no prune
```

Sidecar `<session>.git.json` next to the export: worktree, branch,
base/head SHAs, PR, verdict legs, archived-at — so a restored import
can be re-dated and re-audited later.

### 4. Hooks — one probe, one guard, no new hot-path cost

The mega-hook stays untouched: this spec adds ONE named probe to the
closed `GUARD_PROBES` registry — `archive-eligible` — reading the
verdict legs (plus an optional `minIdle` age floor; age alone never
qualifies, it only holds a finished session back). Declared in
`bro.config.json` like the existing defs:

```json
{ "name": "archive-eligible",
  "when": { "on": ["stop"], "state": { "probes": [
    { "name": "archive-eligible", "args": { "minIdle": "7d" } } ] } },
  "say": "idle ≥7d, worktree clean, nothing unpushed, no open PR — `bro archive run` reclaims it" }
```

Zero cost where the repo doesn't declare it. No stop-gate:
archival is a suggestion, never a blocker (gates, not loops — and
this one has no business gating Stop).

### 5. ACP facade extension — `_bro/archive*`

The proxy pump forwards `_`-methods verbatim (spec bro-rs8sp; the
`_acpx/echo` test pins it), so extension methods already cross both
legs untouched. This spec adds the one deliberate interception: the
pump answers a `_bro/` **prefix locally** instead of forwarding —

- `_bro/archiveStatus` → `{ archivable, blockedBy: [...], led }`
  for the session pane / `bro serve` thin clients;
- `_bro/archive` → runs `bro archive run` for this session and
  returns the export path.

Everything else keeps crossing verbatim — the intercept is a closed
prefix set (`_bro/`), not a handler list that can rot.

## Plan

- [ ] verdict module (pure; git/review/acpx edges injected) + tests
      per blocked leg and the fail-closed paths
- [ ] `packages/acpx` facade: runtime reads, CLI export/import/prune
      wrappers (all `--format json`), sidecar writer
- [ ] `bro archive status|run|prune` + `--dry-run` + exit codes
- [ ] `archive-eligible` probe in `GUARD_PROBES` + config example +
      `bro guard test` coverage
- [ ] `_bro/*` prefix interception in acp-proxy + tests beside the
      `_acpx/echo` ones
- [ ] CHANGELOG + site docs (`bro archive` reference)
