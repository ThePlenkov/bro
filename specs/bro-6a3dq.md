# bro-6a3dq — sdd: scope delegated claims out of the missing-spec nudge + report once per set-change

## Problem

`sddConnector` (`packages/cli/src/commands/spec.ts`) runs
`ownClaimsMissingSpec` on sessionStart + every promptSubmit + stopGate.
Two compounding bugs:

- **Delegated claims are scoped as own.** An orchestrator session that
  claims a bead then hands execution to an agent in another
  worktree/session leaves its `.task` marker in place — the bead is now
  claimed by BOTH sessions. The spec (when it exists) is written in the
  executor's tree, and for the whole delegation window the executor —
  not the orchestrator — owns the spec obligation. Yet the
  orchestrator's nudge fires for the bead's entire delegated lifetime.
- **No dedup.** promptSubmit re-emits the same missing-id line on every
  prompt; with N delegated claims the line grows linearly and spams
  every turn.

The existing parallel exists: the session-start 'armed work' nudge
already detects sibling live sessions via the marker files under
`<git-common>/bro/hooks/` (`markerLive` — owner pid alive, else the
mtime window — plus the same-owner fold of bro-7022c).

## Design

### Scope — newer claim marker wins

Scan `<git-common>/bro/hooks/*.task` once per probe:

- A marker belongs to the **own** side when it is this session's
  `<session>.task` or is stamped by this agent's own process tree
  (`ctx.owner` pid+start — rotated session ids fold in, same rule as
  `ownerTaskClaims` / `otherLiveWork`).
- Any other marker counts **foreign only when live** — `markerLive`:
  an owned marker lives while its owner pid does; an ownerless marker
  falls back to the 24h mtime window (`LIVE_CLAIM_MS`, the
  armed-work nudge's horizon). A dead session's claim is residue and
  must not mask the nudge.
- For each bead id, track the newest **claim stamp** per side — the
  marker's file _birth_ time where the fs reports it (`birthtimeMs`
  via statx), mtime otherwise. `armSession` rewrites a marker's stamp
  line + mtime on every arm, so ordering on mtime would let a session
  claiming fresh _unrelated_ work silently reorder an older shared
  claim (and let the delegator's own next re-arm take a delegated bead
  back). Birth never moves. Filesystems without btime degrade to the
  mtime order. An id in `mine` that a foreign live marker also claims
  with a **strictly newer** stamp is delegated work — the executor's
  fresher claim owns the bead and its spec. Excluded from
  `ownClaimsMissingSpec`, so all three probes drop it at once.
  Per-bead claim times are not stored, so the marker's stamp is the
  granularity — "newer claim marker wins" is a session-level verdict.
- Pins (`BRO_BEAD_ID(S)`) carry no marker stamp (0) — a live foreign
  claim outranks them.

### Dedup — report once per set-change

- Persist the last-reported missing set at
  `<hooks>/hinted/<session>.sdd-missing` — a sha256 of the sorted ids,
  the same digest-file contract `stopHintsChanged` already uses. It
  lives under `hinted/` and never flat beside the markers:
  `readArmed` scans `<session>.*` as gate aspects. `sdd-missing`
  cannot collide with the `sdd` skill-cite stamp.
- `sddSetChanged` compares-and-records: emit only when the digest
  differs; an empty set records too, so a resolved-then-reclaimed
  claim reports again. Fail-open: no session id or no hooks dir →
  report (same contract as the hook's dedup).
- **promptSubmit** consults it — the per-prompt spam vector. Emits
  only on a changed non-empty set.
- **sessionStart** and **stopGate** still report truth every time —
  sessionStart's rehydrate must re-remind after compaction and a
  gate-mode `block` must hold as long as the violation does (remind's
  passive is already display-deduped by `stopHintsChanged`). Both
  record the set so a prompt after them doesn't re-report the same
  claims — **except** a `gate`-mode stopGate, whose `block` the host
  can drop two ways: an unarmed `task` aspect (claims via
  `BRO_BEAD_ID(S)` pins or a rotated session's marker carry no
  `<session>.task` file), or an armed drill/work/act block outranking
  `task` in `GATE_PRIORITY`. A connector cannot see the sibling
  contributions to tell, so gate mode stamps only the empty set —
  which can hide no nudge — and lets the next prompt re-report once;
  remind's passive always lands as context, so it records.

## Plan

- [x] spec.ts: `delegatedTaskClaims` marker scan + `sddHooksDir` via
  `gitCommonDirAsync`, `sddSetChanged` digest file; wire into
  `ownClaimsMissingSpec` + the three probes
- [x] spec.test.ts: delegated-claim exclusion (newer foreign marker
  wins, older stays own, dead sibling ignored), dedup emit-once /
  re-emit-on-change, fail-open paths
- [x] hooks.e2e.test.ts: prompt-submit emits the SDD line once across
  two submits for the same set, and a newer sibling `.task` marker
  silences the nudge end-to-end
- [x] `npm run typecheck` + `npm test` green; act loop per
  skills/act/SKILL.md
