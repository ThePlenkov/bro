# bro-fhs0o — serve: a failed lane must not vanish from the catalog

## Problem

The gateway's `/v1/models` answers the UNION of every lane's catalog. A lane
whose catalog read FAILS is dropped from that union — and the failure is
dropped with it. The client receives a valid, shorter catalog and cannot
tell "this provider is down" from "this provider has no models".

Two things cause the failure, and both are fixable:

1. **The catalog read had a hard-coded 30s budget.** `acpModels`
   (`packages/providers/src/acp.ts:542`) defaults its deadline to
   `Date.now() + 30_000`, and the conductor's catalog path
   (`laneCatalog`) called it without one. A cold ACP spawn that enumerates
   a multi-upstream agent's catalog — `opencode acp` reports 421 models
   across four upstreams — can outrun that budget. Observed live on
   2026-11-04: `/v1/models` answered 122 rows in 33s, and the same
   instance still served opencode turns perfectly. The catalog READ had
   failed; the LANE was alive.
2. **The failure had no channel.** `laneCatalog` catches the error into a
   `failure` string, and `models()` used it only for the all-lanes-down
   502. With one lane alive the string was discarded.

The honest half is the second one: a degraded catalog that reads as a
complete one is worse than an error, because the client believes it knows
the whole menu.

## Design

### The lane's budget bounds the lane's catalog read

The conductor already carries a per-lane timeout — `BRO_PROVIDER_TIMEOUT_MS`,
default 120s — and it bounds every TURN on that lane. A catalog read is the
same kind of operation (a `session/new` plus its model options), so it
rides the same budget. The provider layer keeps its 30s default for
callers that own no budget; the conductor passes its own.

`catalogModels` gains an optional `deadline` (absolute ms) and threads it to
`acpModels`; the cli branch's models-template exec takes the remaining
budget as its spawn timeout instead of its own constant.

### A failed lane rides the response

`/v1/models` answers 200 with the rows it could read, and carries the
failures in a response header:

```
x-bro-lane-error: <lane>: <reason>; <lane>: <reason>
```

The header is the right channel: the body stays the Anthropic-shaped
catalog a client parses, and the degradation is visible to anything that
reads response metadata. A lane that merely advertises NOTHING is not a
failure and says nothing — the distinction the union already draws between
"empty" and "down" stays.

Header values must be latin-1 clean, so the text is sanitized: anything
outside the printable ASCII range becomes `?`. A diagnostic must never be
able to break the response it rides in.

## Plan

- [x] `packages/cli/src/commands/providers.ts` — `catalogModels` takes an
      optional `deadline`; the acp branch passes it to `acpModels`, the cli
      branch spends it as the exec timeout.
- [x] `packages/cli/src/commands/serve-conductor.ts` — `laneCatalog` reads
      under `Date.now() + lane.cfg.timeoutMs`; `models()` carries the
      failures in `x-bro-lane-error`.
- [x] `packages/providers/src/testkit.ts` — the fake agent gains
      `delayNewMs`, a slow `session/new`, so a test can watch a budget
      bound a read.

## Verify

- `serve-conductor.test.ts` — a lane whose catalog FAILS (its
  `session/new` refuses) rides the response header naming it, and the
  healthy lane's rows are still there. A lane that advertises nothing
  rides no header.
- `serve-conductor.test.ts` — the catalog read honours the LANE's budget:
  an agent that answers `session/new` only after 3s under a 150ms lane
  budget ends the read on the lane's deadline (well before the agent
  answers, and long before the 30s constant), and the timed-out lane rides
  the header.
- The CLI suites exercise `@broject/providers` through its BUILD — a
  change to the provider layer needs a rebuild before the CLI tests see it.
