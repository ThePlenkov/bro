# bro-ldvw1 — drive: role lease lapses when a pass blocks >TTL

## Problem

`bro drive` (and `bro loop`) hold a `role/<role>` lease whose renew
runs on a `setInterval(ttlMs/3)` on the main thread
(`holdRoleLease`, `packages/core/src/leases.ts`). A drive pass is full
of synchronous `spawnSync` probes — the agent-connector `list()` walk
in `collectAgents` alone runs docker (`version`/`ps`/`inspect`, 30s
each), tmux (10s), gc (30s), and copilot `gh` calls (30s each). Each
`await conn.list()` resolves on an already-resolved promise, so the
whole walk can run inside one macrotask: the renew timer cannot fire
while any of those children run, and a stack of them blocks the event
loop past the role TTL (`fleet.leases.roleTtlSeconds`, 60s default).

When the loop finally frees, the stored lease's `expiresAt` is in the
past. `store.renew` re-checks `live()` — unexpired AND reachable —
gets `false`, returns `undefined`, and `holdRoleLease`'s `lost()` path
exits 75. Observed: `bro drive --once` exited 75 'role/drive lease
lost' while the docker daemon was unreachable; the stale
`role%2Fdrive.json` holder's lease had expired mid-pass.

The lease did not lose its owner — the owner was alive the whole
time, merely unable to run a timer. Exit 75 is correct for a
*contested* loss (a successor acquired during the gap) or a dead
holder; it is wrong for an uncontested event-loop stall.

## Design

**Renew is a holder-self operation; make it validate ownership, not
freshness.** `LeaseStore.renew` currently requires `live(current)` —
`unexpired && reachable`. Split that predicate: expiry stays the
*contender* signal (it is what lets `acquire`/`read`/`list` hand an
absent holder's key to a successor), while the holder's own renew
checks only

- `tokenMatches(current, lease)` — nobody acquired a successor token
  during the gap (unchanged), and
- `holderReachable(current, deps)` — the same host/pid probe `live()`
  runs, minus the expiry clause: a foreign-host holder is
  unverifiable (reachable, same as `live()`); a same-host holder must
  have a live recorded pid.

```ts
function holderReachable(lease: Lease, deps: LocalDependencies): boolean {
  if (lease.holder.host !== deps.host) {
    return true;
  }
  return deps.pidAlive(lease.holder.pid);
}
```

`renew` then writes `expiresAt = now + ttlMs` from the stored row as
today. No grace window: any bound is arbitrary — a stall's length is
not knowable up front, and an *uncontested* expired lease resuming is
harmless (the role sat idle; the still-live token holder is the right
owner). Contested expiry still loses: a successor's `acquire` during
the gap rewrites the token, the delayed renew mismatches, and the
holder exits 75 exactly as designed. Mutual exclusion is unchanged —
the file lock serializes renew against acquire, and the token is the
arbiter either way.

This also fixes `bro loop`, which holds `role/loop` through the same
`holdRoleLease` and the same sync-probe exposure.

### What does NOT change

- `acquire`, `read`, `list`, `forceRelease` keep `live()` — contenders
  still reclaim expired leases; standby `waitForRole` polling still
  sees an expired role as free.
- `rebind` keeps `live()`. It serves spawn/work leases
  (`workTtlMinutes`, 6h default) through `acquireSpawnLease`'s
  read→rebind path: `store.read` only returns live rows, but the lease
  can expire between read and rebind — today's `live()` re-check is
  what forces the fallthrough to a fresh `acquire`. Relaxing rebind
  could hand back an already-expired lease as "held", opening a
  duplicate-spawn window. `renew` has no such hazard — it always
  writes a fresh `expiresAt`.
- No drive.ts change: the fix is at the lease layer, so every present
  and future sync stall in the pass is covered, not just the docker
  probes observed this time.

### Alternatives considered

- **Bound docker probes + skip** (bead option): `dockerRun` timeouts
  drop from 30s and a daemon-down verdict caches briefly. Rejected as
  the fix — it only shrinks one backend's contribution; tmux, gc,
  copilot `gh`, and any future sync probe can still stack past TTL,
  and several connector `list()`s can jointly block with no timer
  turn between them.
- **Heartbeat child** (the litter-sweep pattern): a spawned process
  renewing the lease during the stall. Works, but duplicates lease
  logic across a process boundary and passes the token around; the
  post-stall renew above is equally correct because an uncontested
  expiry gap is harmless.
- **Async probe twins** (`ghAsync`/`gitTryAsync` style): the
  codebase's long-term direction for probe paths, and it would keep
  the pass responsive *and* the lease fresh. Rejected here as
  disproportionate — it means rewriting every connector's synchronous
  internals; the lease fix is ~15 lines and covers all callers.
- **Yield between connector `list()`s** (`setImmediate`): frees the
  loop once per connector so timers fire mid-`collectAgents`. Helps
  signal responsiveness during long passes but does not cover a
  single connector's internal stall; not needed once renew tolerates
  lateness.

## Plan

- [ ] `packages/core/src/leases.ts` — add `holderReachable`; `renew`
      checks `tokenMatches && holderReachable` instead of
      `tokenMatches && live`
- [ ] `packages/core/src/leases.test.ts` — unit matrix on `renew`
      (expired+reachable renews; expired+dead-pid refuses; expired+
      successor-taken refuses; renewed row re-blocks contenders;
      foreign-host expired renews) plus a `holdRoleLease` regression
      test that busy-blocks the event loop past TTL and asserts no
      exit-75 and a still-held lease
- [ ] verify: `npm run build`, `npm run typecheck`, `npm test` (or the
      CI-equivalent targeted runs); smoke `bro drive --once` if the
      box allows
