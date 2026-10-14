# bro-hpb35 — stop gate: claimed-beads nudge must only reach sessions that armed `task`

## Problem

A bare `ping` in a fresh session got a stop-gate nudge listing beads
claimed by other sessions (`bro: claimed beads open: bro-xeozo, …`).
The beads connector reports in-progress rows it cannot attribute to
this session as a `passive` GateContribution — and `passive` is shown
to everyone, armed or not. Claims live in the shared store (and the
arming markers in the common git dir), so every session in the repo got
the nudge on every stop — for acp-backed models each stop's hook
feedback lands as another context wall.

The gate must only bite sessions that armed task markers themselves.
Ambient repo claims are already surfaced where ambient state belongs:
the session-start `parallelWork` probe (`claimed beads: …`). Repeating
them at stop adds a per-stop echo of information the session can never
act on — it cannot close beads it doesn't own.

## Design

Demote the foreign-claims contribution from `passive` to `armedHint`:

- `block` (verified own claims) — unchanged: only sessions that armed
  `task` are blocked, only by rows whose store assignee matches this
  actor (`isOwnClaim`).
- Foreign rows (not in the marker, or in the marker but owned by
  another actor — a refused claim) — `armedHint`, never `passive`.
  The hook shows `armedHint` only to sessions that armed the aspect
  and aren't blocked, so a fresh session sees nothing and a session in
  the task business still sees which beads are held elsewhere.

Same pattern the `work` connector already uses: a linked worktree is
`armedHint` for the session that created it, invisible to everyone
else. The `parallelWork` session-start probe remains the ambient
surface for other sessions' claims.

Rejected alternative: drop the contribution entirely. The refused-claim
case (this session ran `bro work enter b1`, another actor holds b1) is
worth a hint to the session that attempted it — `armedHint` keeps it.

## Plan

- [ ] `packages/core/src/connectors.ts` beads `stopGate`: foreign
      claims contribute `armedHint`, not `passive`
- [ ] `packages/core/src/connectors.test.ts`: refused claim stays an
      armed hint; no task contribution carries `passive`
- [ ] `packages/cli/src/commands/hooks.e2e.test.ts`: a fresh session's
      stop emits no claimed-beads line; a `task`-armed session gets the
      hint (no block)

## Acceptance

- `bro hooks stop` for a session with no arming markers in a repo with
  foreign in-progress beads emits nothing about claimed beads.
- A session that armed `task` still blocks on verified own claims and
  sees foreign claims as a hint only.
- Session-start `parallelWork` still names foreign claims — the ambient
  channel is unchanged.
