---
parent: bro-5tpx0
---

# bro-gwh2a — hooks: resident config/guard cache — parse once per mtime, serve N calls

## Problem

Every `bro hooks <event>` is a cold Node process that re-pays the same
fixed cost the last invocation paid seconds ago:

- `loadConfigLayers` runs once per `loadConfig` call — and the hook path
  calls `loadConfig`/`loadBroConfig` ~5–10× per event (CLI `prepare`'s
  `loadExternalPlugins`, `guardLines`, `pickConnectorAsync`'s prefer
  read, the learn/act connectors, `sinks`). Each scan stats ~12
  candidate files across three layers plus `gitCommonDir`, and a
  `bro.config.ts` winner re-evaluates the module (up to a node
  subprocess) on every single call.
- `collectGuards` re-runs every connector's `guards()` and re-emits the
  identical stderr warning per call — measured evidence (bead notes,
  2026-10-28): `guard 'test-coverage-on-stop' from guard duplicates an
  earlier declaration` on EVERY invocation.

A resident daemon endpoint was the alternative; this bead takes the
cheaper arm it allows: a per-repo on-disk cache keyed by file
fingerprints. Hooks are separate processes, so "memory" = a small JSON
record under `<git-common>/bro/hooks/cache/` — parse once, N
invocations read bytes.

## Design

### Hot path

`loadConfigLayers` (core/config.ts) gains a per-(resolved cwd, layer)
file cache; `collectGuards` (core/connectors.ts) gains a
per-(dir, session, defs-hash, contributor-set) file cache with a TTL.
Everything else stays live — guard *evaluation* still reads real
state per event; only the *parse/collect* half is cached.

### Cache location + mechanics (`hook-cache.ts`, new in core)

- Dir: `<git-common>/bro/hooks/cache/` via `gitCommonDir` (in-process
  memoized already; null outside a repo → caching silently off, same
  as the lessons/drills snapshots).
- `BRO_HOOK_CACHE=0` disables both caches (debug escape hatch).
- Records: one JSON object per file, written `tmp+rename` (torn writes
  never poison readers — the snapshots' existing contract), never
  locked. `config-layer-<layer>-<sha8(dir)>.json`,
  `guards-collected-<sha8(dir|sessionId)>.json`.
- Write opportunistically sweeps same-prefix siblings older than 24h —
  session-keyed files can't accumulate.
- Every read is fail-open: corrupt JSON, wrong version, mismatched
  fingerprint → miss → the real scan/collect runs. A failed read or
  write never throws.

### Layer cache (config.ts)

`probeLayerCandidate` records each probed candidate as
`{path, exists, mtimeMs?, size?}` (statSync alongside the existing
existsSync). Per wanted layer the loader first reads the record:

- **Hit** — `v`/`dir`/`layer` match and every recorded probe re-stats
  identically → the cached `{hit, broken}` is returned. The whole
  layer costs ~15 stat syscalls, zero file reads, zero warnings.
- **Miss** — the real scan runs (with recording) and the record is
  rewritten.

Fingerprint coverage is exact: a config file appearing, disappearing,
or changing (mtime or size) anywhere in the probed set misses →
rescan. Dirs never probed can't affect the result while the recorded
set stands; the cache living inside git-common means a worktree
topology change lands in a different cache dir → natural miss.

**Cacheability rule:** `.json` files are pure data — their records
live on the fingerprint alone. A scan that touched an *existing* `.ts`
file may have evaluated code (`process.env`, imports, computed
values), so its record is written only when the parsed `raw`/`pluginsRaw`
round-trips through JSON (a function/cycle would corrupt on the way
back) and carries a `ts` — valid for 60s. Dynamic configs keep
evaluating; static `.ts` configs still skip ~60 re-parses a minute.

`loadConfig`/`loadBroConfig` are unchanged above the seam: merge +
`applySections` still run per call (pure, µs), so section schemas that
return non-JSON values are unaffected — a correctness boundary the
applied-config level could not have kept.

### Collected-guards cache (connectors.ts)

`collectGuards(ctx, defs)` checks
`guards-collected-<sha8(resolve(dir)|sessionId)>.json` first:
fingerprint = `{defs: sha256(JSON), contributors: names of connectors
declaring guards()}` plus `ts` with a 5-minute TTL. Hit → the cached
`CollectedGuard[]` returns; no `guards()` calls, no dedup warnings —
the dup-declaration complaint dies here. Miss → collect live (warnings
fire once per fingerprint), write the record.

- `sessionId` sits in the key so a hypothetical per-session connector
  guard can't leak across sessions; `defs` hash makes config edits
  invalidate instantly; the contributor list makes a
  registered/unregistered connector (external plugin load, tests)
  invalidate.
- The TTL bounds the only thing fingerprints can't see — a connector
  `guards()` that computes per call (an anti-pattern; guard clauses
  exist for per-event dynamism). Worst case staleness: 5 min; the dup
  warning re-fires at most once per 5 min per session, not per call.
- `bro guard list`/`guard test` share the seam — same bounds apply.

### What is NOT cached (and why)

- Guard *evaluation* (on/match/state/budget) — live state is the
  point; unchanged.
- External plugin module imports in `prepare` — module loading is not
  a parse.
- `beadsStoreStamp`-keyed probe snapshots — #761 already owns them.

## Failure modes — all fail-open

Corrupt/truncated cache file → miss → live path. Unwritable cache dir
→ write skipped silently. Cache dir on a wedged filesystem → bounded
by the same stat/readFile the live path already does; the hook
deadline (spec bro-36sx7.13) stays the outer bound. A stale hit is
impossible by construction except the two documented bounds
(mtime+size identical rewrite; dynamic `guards()` inside the TTL).

## Test scenarios

1. Second `loadConfigLayers` on an unchanged repo serves from cache —
   proven by making the config unreadable (chmod) after the first
   load; a live load would break, the cache still answers.
2. mtime invalidation — touching the config file flips the record to a
   miss and re-reads.
3. New competing file appears (`bro.config.local.json` written after
   caching) — recorded-missing path now exists → miss.
4. Corrupt cache file → clean live load, record rewritten.
5. `bro.config.ts` winner → record written with a `ts` TTL tag;
   a `.json`-only scan's record has no expiry.
6. `collectGuards` duplicate names warn once per fingerprint — second
   call is silent but returns the same rows.
7. `BRO_HOOK_CACHE=0` → every call live.
8. Non-repo dir → no cache, identical results.
