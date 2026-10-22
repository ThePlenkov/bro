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

`projectId = sha256(normalizeRemote(origin))[:16]`, where normalize does
lowercase host, strip `.git`, scp→url, drop userinfo/token, and drop the
proxy prefix (`git-manager…/proxy/`). With no origin, it falls back to
`sha256(realpath(git-common))`. Every clone of one repo gets one id.

### Store (interface first, local impl now)

```ts
interface LeaseHolder { host: string; pid: number; rig: string; agentId?: string; sessionId?: string }
interface Lease { key: string; token: string; holder: LeaseHolder; acquiredAt: string; expiresAt: string }
interface LeaseStore {
  acquire(key: string, holder: LeaseHolder, ttlMs: number): { ok: true; lease: Lease } | { ok: false; held: Lease }
  renew(lease: Lease, ttlMs: number): Lease | undefined   // undefined = lost
  release(lease: Lease): void                             // token-checked, idempotent
  read(key: string): Lease | undefined                    // live leases only
}
```

- Local impl: `$XDG_STATE_HOME/bro/projects/<projectId>/leases/<enc(key)>.json`.
  Each acquire, renew, or release is a read-check-write under
  `withFileLock` on that file. `enc` must be injective (encodeURIComponent).
- A lease is dead once `expiresAt` passes, **or** once `holder.host`
  is this host and `holder.pid` is dead. A crashed holder on the same
  host frees its lease right away, and the TTL is the backstop.
- Keys: `bead/<id>`, `pr/<owner>/<repo>/<n>`, `role/loop`, `role/drive`,
  `role/dispatch`.

### Uses

1. **Work lease in the spawn critical section.** Right after the claim
   guard, `prepareSpawn` acquires `bead/<molStep>` with the worker's
   identity: the pid after start, rebound from the spawning pid. If
   another holder has it, that's a `SpawnError` ("bead X leased by
   `<rig>@<host>` pid N until T"). `bro agents run --for`, `bro flow
   next`, and the loop's pick all try the lease before `bd --claim`, so
   when a bead is held they skip it and pick the next ready one. The
   lease is released on the exit record. `agents down` force-releases
   it.
2. **PR fixer lease.** `drive` takes `pr/<…>/<n>` before it spawns a
   fixer. If another bro already leases that PR, the PR is skipped and
   shown as `leased`.
3. **Role leases.** `bro loop` and `bro drive` (and the daemon's drive
   supervisor) acquire `role/loop` or `role/drive`. The holder renews
   every ttl/3, with ttl defaulting to 60s. An instance that loses the
   lease or finds it held runs in standby the way the second loop does
   behind `loop.lock` today: it polls `read()` and takes over once the
   lease expires. The existing git-common locks stay as the inner
   guard.
4. Interactive sessions: `bro work enter` / `bd --claim` through the
   hook acquire `bead/<id>` as a **soft** lease. The ambient-detection
   rule ("never a block") holds for interactive sessions. A bro batch
   spawn treats a soft lease as held.

### Tests

acquire/renew/release; expiry; dead-pid reclaim; token mismatch;
encode collisions (`a/b` vs `a%2Fb`); two processes racing acquire
(exactly one wins, child_process fork test); two clones with the same
origin → same projectId; a proxy/scp/https remote → same id; prepareSpawn
refuses a leased bead; loop standby → takeover after release.

### Phase 2 (not now)

A git CAS store: `refs/bro/leases/<enc(key)>` on origin, using
`git push --force-with-lease=<ref>:<expected>` like `refs/bro/data`
(dataref.ts). It's selected with `fleet.leases.store: "git"` for
multiple hosts (Devin cloud, CI, a second laptop).
