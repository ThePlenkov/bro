# bro-acjzf — delegate --wait: the wall verdict rides into turn admission

## Problem

`bro fleet delegate --wait` checks provider walls ONCE, before
`acpOpen` (`refuseWalled` in delegate-provider.ts). Between that read
and the pooled turn's `session/new` sits the whole peer bring-up —
process spawn plus the initialize handshake — a seconds-wide window in
which a concurrent worker (a batch spawn, another delegate, a
conductor lane) can hit the provider's wall and record it in the
registry/ledger. The delegate then opens a session and spends quota
on a lane the fleet already knows is walled. Deferred review finding
from PR #652.

The conductor lane already answers this: `acpSessionOpen` consults
`gc.cooldown.refusal()` immediately BEFORE the session opens (spec
bro-i6811) — the wall verdict is spoken inside the admission, so a
wall landed during peer bring-up still refuses the spend and costs no
session and no quota. `delegate --wait` never wired its wall source
into that seam — it checked early and trusted the verdict to stay
fresh across `acpOpen`.

## Design

### The seam exists — widen what plugs into it

`AcpGuardCtx.cooldown` is typed `AcpLaneCooldown`, the conductor's
in-process lane state, but `acpSessionOpen` only ever calls
`.refusal()`. Extract the admission contract:

```ts
export interface AcpWallCheck {
  refusal(now?: number): AcpWallRefusal | undefined;
}
```

`cooldown?: AcpWallCheck` — `AcpLaneCooldown` still satisfies it and
`armWallFromError` keeps the concrete class (arming is lane
machinery, not admission). A foreign wall source — the fleet's
registry/ledger walls — can now back the same seam without owning a
lane cooldown.

`AcpGuardCtx.guard` becomes optional (`gc?.guard?.open(gc)`,
`guardFail` skips a guardless ctx): a ctx that carries only a wall
check needs no churn accounting — the delegate ctx is per-request and
a fresh-per-request guard would measure nothing.

### The delegate's wall check

`delegate-provider.ts` gains `delegateWallCheck(dir, provider):
AcpWallCheck` — `refusal()` runs the same fail-closed
`providerWallsFor` walk the early gate runs and maps a matching
`ProviderWall` to `{reason, retryAfterSec}`:

- `reason` — the same text the early `SpawnError` carries
  (`wallText(wall) — the delegate lane waits; retry after the reset or
  --detach to a different lane`), so the refusal reads the same
  wherever it is caught;
- `retryAfterSec` — `wall.until` when the wall advertises an end,
  else a 60s default.

`delegate-wait.ts` keeps the early `refuseWalled` (a walled lane
should not even pay the peer spawn) and passes
`guard: {scope: 'delegate:<name>', cooldown: delegateWallCheck(dir, name)}`
to `acpPooledTurn` — the verdict is re-read inside `acpSessionOpen`,
immediately before `session/new` spends.

Refusal surface: `AcpCooldownError` propagates unwrapped (the
conductor contract — the refusal costs no session), so the CLI prints
the wall plus a retry hint either way. A corrupt-registry read inside
`refusal()` still fails closed — it surfaces as a `JudgeUnavailable`
naming the wall read, the same verdict at a later moment.

### The documented residual

True atomicity is not available and not needed. The wall sources are
files other processes write (registry exit harvest, host ledger) —
no lock can span "check" + "turn finishes" without holding a file
lock for the turn's whole lifetime, and a wall landing mid-turn must
not kill a turn already spending (the wall throttles NEW spend, not
in-flight work). The residual window — the synchronous preamble
between `refusal()` and the `session/new` write — is microseconds; a
wall that lands inside it is an accepted race: the turn in flight
finishes, the next admission refuses.

## Verify

- `delegate.test.ts` — a wall landed mid-open (written from the
  `acp.peer` resolver, the exact `refuseWalled` → `session/new`
  window) refuses the turn with `AcpCooldownError` naming the wall;
  `fake.sessions`/`fake.prompts` stay empty — no session was opened.
- `delegate.test.ts` — `delegateWallCheck` unit rows: a clean
  registry answers `undefined`; a walled provider answers reason +
  `retryAfterSec`.
- `acp.test.ts` — `acpPooledTurn` honors a structural (non-
  `AcpLaneCooldown`) wall check on a `guard`-less ctx: refuses with
  `AcpCooldownError` before `session/new`.
- `npm run build`, `npm run typecheck`, `npm test` — the CI commands.
