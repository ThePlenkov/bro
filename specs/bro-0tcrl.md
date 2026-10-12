---
scope:
  - packages/act/src/state-cache.ts
  - packages/act/src/state.ts
  - packages/act/src/index.ts
  - packages/act/src/connector.ts
  - packages/cli/src/planes/gates.ts
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/commands/act.ts
  - packages/cli/src/commands/status.ts
  - packages/cli/src/commands/serve.ts
---

# bro-0tcrl — one shared gate-state feed: a file-backed PrActState cache

## Problem

`fetchPrActState` costs 5–7 host calls (prMeta, threads GraphQL,
checks ×2, reviewedShas, SAST annotations, file list when threads are
open). Every poller pays it independently per PR:

- `bro loop` — each fleet member's service tick (~60s cadence)
- `bro watch` — every fleet PR per heartbeat (~60s)
- `bro drive` — every open PR per pass (~300s)
- `bro act wait` — one PR per interval (~60s)
- connector hook probes (sessionStart / promptSubmit / stopGate)

At ~14 open PRs that is hundreds of host calls per hour — secondary
rate limits, slower polls, a slower gate. Annotations pooling
(bro-2l7r9 follow-up) cut the fan-out *per* fetch; nothing cuts the
number of *fetchers*.

## Design

### The shared feed — `<git-common-dir>/bro/act-state/<repo>-<pr>.json`

A `PrStateCache` beside the check-history ledger (same shared dir, same
cross-worktree/cross-process reach, same fail-open contract):

```ts
export interface PrStateCache {
  /** A fresh entry — null on miss, expiry, corruption, or a read
   *  failure. */
  read(target: PrTarget): PrActState | null
  /** Atomic publish (tmp + rename); opportunistically reaps entries
   *  past STALE_MS so settled PRs don't accumulate files. */
  write(target: PrTarget, state: PrActState): void
  /** Drop one target's entry — under its lock so a racing fetch's
   *  late write can't resurrect pre-mutation state. */
  invalidate(target: PrTarget): void
  /** Drop every entry — thread mutations arrive by thread id with no
   *  PR attached. */
  invalidateAll(): void
  /** Per-target fetch lock — the read→fetch→write critical section.
   *  A contender that can't take it inside waitMs gets null and
   *  proceeds uncached (the lock is dedup, never a gate). */
  acquire(target: PrTarget, waitMs?: number): (() => void) | null
}

prStateCache(dir, { ttlMs?, lockWaitMs? }): PrStateCache | null
```

- Record shape: `{ fetchedAt, state }`. TTL default 30s — under every
  poll interval (a lone poller still fetches each pass; overlapping
  pollers share). `lockWaitMs` default 15s (≈ one fetch); hook contexts
  pass 0 (a try-lock — never stall a budgeted hook on a peer's fetch).
- Dead-holder locks are stolen by the filelock pid probe; a crashed
  fetcher strands nothing.

### fetchPrActState — the one entry point

```ts
const hit = cache?.read(target);      if (hit) return hit
const p   = inflight.get(key) ??      // same-process dedup
            fetchShared(...)          // lock → re-read → fetch → write
```

- A second caller mid-fetch gets the in-flight promise — no
  in-process duplication even without a cache.
- Under the acquired lock the entry is re-read: a contender that
  waited on a peer's fetch reads the winner's write instead of
  paying its own 5–7 calls.

### Who reads the cache — pollers; who doesn't — deciders

Cached (observe-only): gates plane `stateOf`, `watch` fleet gates,
`loop` member gates, `drive` per-PR pass + fixer sweep, `act status`,
`act wait` polls, `status --deep`, connector gate probes.

Uncached (the state IS the decision): `act merge`'s pre-merge gate,
`stack merge`'s gate, `drive`'s post-merge re-probe. Every merge path
already funnels through `cmdMerge`'s own fetch — `landPr`'s
`expectedHeadSha` pin closes the rest.

### Invalidation — mutations drop entries

- `act resolve`/`reply`/plan verdicts → `invalidateAll` (thread ids
  carry no PR).
- `landPr` landed/enqueued, `updateBranch` accepted → `invalidate(t)`.
- Loop gate re-entry after a mutation round → `invalidate(t)`: a
  fix/rebase worker's exit and the post-respawn re-poll must read
  post-round truth, not the ≤ttl-old snapshot that spawned the round
  (else the immediate 'active' re-poll re-triggers the same action and
  burns every round inside one window).
- Drive fixer dispatch → `invalidate(t)`, and the fresh-probe early
  returns (`threads-resolved`, `conflict-resolved`, `settled`) that
  prove the snapshot stale.
- Webhook publish (`serve` `github:*` route) → `invalidate` per
  `payload.prs`, all entries when the delivery names none — mirroring
  `githubEventConcernsPr`, so a woken `act wait` never polls a cache
  the event itself just obsoleted.

## Test plan

- `npm run build`, `npm run typecheck`, `npm test` (the CI trio).
- New `state-cache.test.ts`: write→read round trip, TTL expiry,
  corrupt/absent files read as miss, pr-mismatch reads as miss,
  invalidate/invalidateAll, lock acquisition + contender null.
- `state.test.ts` additions over the real cache in a tmp dir: a hit
  pays zero facade calls, a miss fetches + publishes, concurrent
  same-target callers share one fetch.
