# bro-vknim — pooled-peer concurrency and failure domain

## Verification

The conductor warm pool keeps one ACP child and one JSON-RPC connection per
lane. `acpPooledTurn` opens a distinct `session/new` for each request, so
independent sessions share that connection. The provider does not add a
process-wide turn mutex: the ACP SDK accepts both `session/prompt` requests
while they are in flight, and routes each `session/update` by `sessionId`.
`packages/providers/src/acp.test.ts` proves this with two held, distinct
sessions on one peer; both prompts complete and both `session/new` requests
are observed.

This does **not** make one session re-entrant. A second prompt for the same
session would race its single update pump and is rejected by the brokered
session surface (see `specs/bro-ymbq1.md`).

## Failure domain

The warm pool is a single-child failure domain for every session in its lane:

- a child crash, dead transport, or account-wide Devin rate limit invalidates
  the peer and can terminate all sessions using it;
- respawn is lazy and happens on the next request; it cannot resume turns that
  were in flight when the child died;
- `DEVIN_PERMISSION_MODE` (and equivalent provider command environment) is
  process-wide, so changing it affects every pooled session;
- the pool's loopback-only listener (`127.0.0.1`) is the tenancy boundary.
  Any exposure beyond loopback requires per-session isolation rather than
  relying on the shared child.

Concurrency therefore means independent sessions can overlap on one peer, not
that the peer is an isolation boundary or that one session can overlap its own
turns.
