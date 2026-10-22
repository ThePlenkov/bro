---
parent: fleet-routing
scope:
  - packages/core/src/providers.ts
  - packages/core/src/routing.ts
  - packages/core/src/agents.ts
  - packages/core/src/wall-ledger.ts
  - packages/core/src/leases.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/commands/fleet.ts
  - packages/cli/src/commands/loop.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/plugins.ts
  - skills/providers/
  - skills/loop/
  - skills/drive/
---

# bro-r8y77 — Free-router fleet: account-scoped walls + project leases

Status: draft. Follows spec bro-1x7p (M3 chain walk). Two parts: B is
account walls, C is leases.

## Problem

1. A wall is derived from `<git-common>/bro/agents.json`, so it lives
   in one checkout (spec bro-9h86l §"account-wall scope"). Free-router
   quotas are per **account**. openrouter rate-limited in repo X still
   looks green in repo Y, so the Y chain walk spawns straight into the
   wall.
2. Two provider names can draw on one account (say `kilo-cli` and
   `kilo-acp`), and today a wall on one is invisible to the other.
3. `loop.lock`, `drive.lock`, `agents.json`, and the bd claim are
   scoped to a git-common dir. Two clones of one project each run their
   own loop/drive and each claim the same ready bead.

## B — account identity + host wall ledger

### Config

Every `ProviderEntry` kind accepts an optional
`providers.<name>.account?: string`, parsed like the other optional
strings. A non-string value drops only this field with the usual
`bro.config` error line. The label is opaque; core never interprets it.
`providerAccount(providers, name): string` returns
`providers[name]?.account ?? name`, so providers that share a label
share a wall and an absent label preserves today's provider-scoped
behavior.

```jsonc
"providers": {
  "kilo-cli": { "type": "acp", "command": "kilo acp", "account": "kilo" },
  "kilo-run": { "type": "cli", "command": "kilo run …", "account": "kilo" },
  "or-free":  { "type": "cli", "command": "…", "account": "openrouter:petr" }
}
```

The resolved account rides the spawn: `resolveSpawnProvider` carries it
with the selected provider/model/worker, `SpawnSpec.account` and each
`route.candidates[i].account` carry it through routing, and the registry
stores it on the live entry and outgoing attempt. A legacy entry without
`account` uses `provider` as its account, so wall classification needs no
providers map.

### Ledger

- Path: `$XDG_STATE_HOME/bro/walls.json` (default `~/.local/state`), as
  in `notify.ts`; an empty `XDG_STATE_HOME` means unset. The ledger file
  is mode 0600 and its directory mode 0700. Every write goes through
  `withFileLock(<path>.lock)` and publishes via atomic temp-file +
  rename.
- Shape: `{ version: 1, walls: { [account]: WallObservation } }`.
  `WallObservation = { cause: 'rate_limited'|'quota', resetAt?, observedAt, provider, rig, step? }`.
- API: `recordWall(obs, opts?)`, `readLedgerWalls(now, ttls?)` (live
  `AccountWall[]` only), and `clearLedgerWalls(account | 'all')`, which
  returns the number of removed rows. Tests inject the clock and path
  through options; production uses no global fakes.
- Merge: newest observation wins, except a live `quota` row is not
  replaced by a `rate_limited` row. Expired rows are pruned on write.
- Recovery: unreadable or corrupt data is an empty ledger on reads, with
  one stderr warning; the next record rewrites it.
- Writer: when an exit is classified as `rate_limited` or `quota` and
  the entry has a provider, record
  `{ account: entry.account ?? entry.provider, provider, cause,
  resetAt, observedAt: now, rig, step }`. This is best-effort: a ledger
  write failure warns but never fails classification.
- TTL config: `fleet.walls.rateTtlMinutes` defaults to 15 and
  `fleet.walls.quotaTtlMinutes` defaults to 360. Invalid values drop the
  affected field with a `bro.config` error line.
- Expiry, because a ledger row can't be cleared by `agents down` in
  some other repo:
  - `rate_limited` with `resetAt` → expires at `resetAt`;
  - `rate_limited` without it → `observedAt + rateTtlMinutes`
    (default 15m);
  - `quota` → `resetAt` ?? `observedAt + quotaTtlMinutes`
    (default 6h).
- Reader: `spawnWalls(dir, registry, now)`, the M3 seam, combines
  account-aware registry walls and live ledger walls. Registry
  aggregation retains `deriveProviderWalls` semantics, keyed by
  `rec.account ?? rec.provider`; `deriveAccountWalls(registry, now)`
  folds the same records by account. A provider is walled when either
  its provider wall or its account wall is live. The combined result
  expands to each route candidate/provider affected and includes the
  optional `account` on `ProviderWall`; `walkChain` itself is unchanged.
  Unrouted `batchWallRefusal` checks both `spec.provider` and
  `spec.account`.
- Lift: `bro fleet walls [--json]` lists live ledger rows and
  registry-derived walls for this repo with `source: ledger|registry`.
  `bro fleet walls clear <account>` and `bro fleet walls clear --all`
  delete ledger rows and print the count. `agents down <step>` still
  clears only the local entry and does not touch the ledger.
- `bro fleet` and `bro watch` use the combined wall derivation for their
  existing wall rendering and label walls with the account.

### Non-goals

No cross-host wall sharing in B. Each laptop and Devin VM learns on its
own. Phase 2 can put the ledger on a git ref if a real need shows up.

## C — project-scoped renewable leases

### Project identity

`normalizeRemote(url)` lowercases the host, strips a trailing `.git` and
trailing slash, converts scp remotes such as `git@h:o/r` to `h/o/r`, and
drops the scheme, userinfo, query credentials, and proxy prefix (for
example `http://git-manager…/proxy/github.com/o/r` becomes
`github.com/o/r`). `projectId(dir) = sha256(normalizeRemote(origin))[:16]`.
It reuses core's existing origin-URL helper; with no origin it falls back
to `sha256(realpath(git-common))[:16]`. No new git-spawn path is added.
Every clone of one repo gets one id.

### Store (interface first, local impl now)

```ts
interface LeaseHolder { host: string; pid: number; rig: string; agentId?: string; sessionId?: string }
interface Lease { key: string; token: string; holder: LeaseHolder; acquiredAt: string; expiresAt: string }
interface LeaseStore {
  acquire(key: string, holder: LeaseHolder, ttlMs: number): { ok: true; lease: Lease } | { ok: false; held: Lease }
  renew(lease: Lease, ttlMs: number): Lease | undefined   // undefined = lost
  release(lease: Lease): void                             // token-checked, idempotent
  read(key: string): Lease | undefined                    // live leases only
  rebind(lease: Lease, holderPatch: Partial<LeaseHolder>): Lease | undefined // token-checked, same expiry
  forceRelease(key: string): boolean                      // whether a row existed
  list(): Lease[]                                          // live leases only
}
```

- Local impl: `localLeaseStore(projectId, opts?)` at
  `$XDG_STATE_HOME/bro/projects/<projectId>/leases/<encodeURIComponent(key)>.json`;
  an unset or empty `XDG_STATE_HOME` uses `~/.local/state`. `opts` injects
  `stateHome`, `now`, `host`, and `pidAlive` for tests.
- Every operation is a read-check-write under `withFileLock(<file>.lock)`.
  Writes use a same-directory temp file and atomic rename; directories are
  mode 0700 and lease files mode 0600. Tokens are `randomUUID()` values.
- A lease is dead once `expiresAt` passes, **or** when
  `holder.host === os.hostname()` and `process.kill(pid, 0)` reports
  `ESRCH`; `EPERM` counts as alive. A foreign-host pid is ignored until
  TTL expiry. `renew`, `release`, and `rebind` are token-checked;
  `release` is idempotent, while `forceRelease` is the admin override.
- Keys: `bead/<id>`, `pr/<owner>/<repo>/<n>`, `role/loop`, `role/drive`.

### Lease configuration

`fleet.leases: { roleTtlSeconds?: number (default 60),
workTtlMinutes?: number (default 360) }`. Invalid values are dropped
with the usual `bro.config` field error.

### Uses

1. **Work lease in the spawn critical section.** Immediately after the
   claim guard and before the registry write, `prepareSpawn` acquires a
   work lease with `{host, pid, rig, agentId}` and
   `workTtlMinutes`. Drive fixers use the shared `spawnStepAgent` /
   `prepareSpawn` path and carry `BRO_PR` plus `BRO_PR_URL`, so their key
   is `pr/<owner>/<repo>/<n>`; other spawns use `bead/<molStep>`. If
   another live holder owns the key, spawn throws a `SpawnError` of kind
   `cap` naming the key, holder (`<rig>@<host>`), pid, and expiry. A
   respawn reuses or rebinds its lease when the existing registry entry's
   token matches the live lease. Once the worker starts, the holder pid
   is rebound to the worker pid. Spawn failure and exit classification
   release the lease; `agents down <step>` force-releases its key.
2. **Pick skip.** `bro loop`'s existing ready-bead pick skips a bead
   whose `bead/<id>` lease is held by another live holder and logs the
   holder. `bro flow next` and `agents run --for` do not share that pick
   helper and do not add a separate pick path.
3. **Role leases.** `bro loop` acquires `role/loop`; `bro drive` (also
   the daemon's in-process drive command) acquires `role/drive`. Both
   acquire before their existing `loop.lock`/`drive.lock`, which remain
   the inner guard. `holdRoleLease(store, role, holder, ttl, {signal})`
   waits behind a live lease, logging
   `standby — role/<x> held by <rig>@<host> pid N`, polling at
   `min(5s, ttl/3)`. The leader renews at `ttl/3` on an unref'd interval.
   A lost lease logs `role/<x> lease lost — exiting`, releases the inner
   lock, and exits 75; normal exit and SIGINT/SIGTERM release the lease.
   The daemon/operator restarts a lost leader, which re-enters standby.
4. **Fleet CLI.** `bro fleet leases [--json]` lists live leases with key,
   holder rig/host/pid, agent id, acquired time, and expiry.
   `bro fleet leases release <key>` force-releases and reports whether
   a row existed.

### Tests

Lease acquire/renew/release; expiry; dead-pid reclaim; foreign-host pid
ignored until TTL; token mismatch on renew/release/rebind; encoded-key
separation (`a/b` vs `a%2Fb`); force-release; live list; two forked
processes racing acquire (exactly one wins). Project identity covers
https, scp, ssh, token/userinfo, proxy-prefixed, and trailing-`.git`
forms of one repo, another repo, and no-origin git-common fallback.
Spawn coverage includes a foreign-held bead error, same-step respawn
reuse, exit-classification release, and `agents down` force-release.
Role coverage includes standby/takeover and renewal loss; loop picking
skips a leased bead. Fleet leases CLI covers list/release and argv errors.

### Phase 2 (not now)

Soft leases for interactive `bro work enter` / `bd --claim` hook flows
and a git CAS store at `refs/bro/leases/<enc(key)>` on origin (using
`git push --force-with-lease=<ref>:<expected>` like `refs/bro/data`)
are tracked in child bead `bro-r8y77.4`; neither is implemented here.
