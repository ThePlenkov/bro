/**
 * The decision cache's store operations (spec bro-0ykhg.3) — the
 * memoized T2 stage answers `brouter.router.cache` opts into.
 *
 * Two tables share the work: `decision_cache` holds the entries
 * (key → stage-answer JSON + TTL), `decision_cache_gen` holds the
 * per-key GENERATION — a counter that outlives the entry so an
 * invalidation landing while a decision is mid-flight still wins: the
 * in-flight write captured the old generation and its compare-and-set
 * rejects it. Invalidation bumps the generation even when no entry
 * exists, which is exactly what makes a late write unable to resurrect
 * a failed answer.
 *
 * Every mutation is a SQLite transaction (`BEGIN IMMEDIATE` — the
 * write lock is taken up front so two processes cannot interleave a
 * read-check-write). Reads stay plain selects: a lookup that races an
 * invalidation may see the pre-invalidation entry, and that is safe —
 * the generation the journal records is the one the write checks.
 */
import type { StoreFace } from './decisions.ts';
import { tightenStoreFiles } from './privacy.ts';
import type { RouterDb } from './store.ts';

/** One cache entry, as stored. */
export interface CacheEntry {
  /** sha256 over the canonical key JSON — the lookup identity */
  keyHash: string;
  /** the canonical key JSON — contextId, hashes, shape, task/cluster */
  keyJson: string;
  /** the project namespace the key was minted under */
  contextId: string;
  /** the stage answers as JSON — never the final route */
  valueJson: string;
  /** the per-key generation this entry was written under */
  generation: number;
  /** epoch ms the entry was written */
  createdAt: number;
  /** epoch ms the entry stops answering — the TTL */
  expiresAt: number;
}

interface CacheRow {
  key_hash: string;
  key_json: string;
  context_id: string;
  value_json: string;
  generation: number;
  created_at: number;
  expires_at: number;
}

const toEntry = (row: CacheRow): CacheEntry => ({
  keyHash: row.key_hash,
  keyJson: row.key_json,
  contextId: row.context_id,
  valueJson: row.value_json,
  generation: row.generation,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** The key's current generation — 0 when the key was never seen
 *  (never written, never invalidated). Synchronous: the caller already
 *  holds the store open. */
export function cacheGeneration(db: RouterDb, keyHash: string): number {
  try {
    const row = db.$client
      .prepare('select generation from decision_cache_gen where key_hash = ?')
      .get(keyHash) as { generation: number } | undefined;
    return row?.generation ?? 0;
  } catch {
    return 0;
  }
}

/** The live entry for a key — undefined on a miss, an expired TTL, or
 *  an unreadable store. The generation is NOT checked here: the caller
 *  compares it against `cacheGeneration` so a hit can be journaled
 *  with the generation it was read under. */
export function readCacheEntry(
  db: RouterDb,
  keyHash: string,
  now: number = Date.now()
): CacheEntry | undefined {
  try {
    const row = db.$client
      .prepare('select * from decision_cache where key_hash = ?')
      .get(keyHash) as CacheRow | undefined;
    if (row === undefined || row.expires_at <= now) {
      return undefined;
    }
    return toEntry(row);
  } catch {
    return undefined;
  }
}

/** Roll back a transaction that failed mid-write — already-rolled-back
 *  is not an error. */
function rollback(client: RouterDb['$client']): void {
  try {
    client.exec('ROLLBACK');
  } catch {
    /* already rolled back */
  }
}

/** Write a cache entry — the compare-and-set half of the contract.
 *  Lands only while the key's generation still equals `generation`
 *  (the value captured BEFORE T2 ran): an invalidation that landed
 *  mid-flight bumped it, and this write must not resurrect the stale
 *  answer. Returns false on a stale generation — the ordinary reject —
 *  and on a store failure (warned, never thrown: the cache is a memo,
 *  not a gate). */
export async function writeCacheEntry(
  store: StoreFace,
  input: {
    keyHash: string;
    keyJson: string;
    contextId: string;
    /** the stage answers as JSON */
    valueJson: string;
    /** the generation captured before T2 — the write's expected value */
    generation: number;
    /** epoch ms the entry was written — defaults to now */
    createdAt?: number;
    /** the TTL in ms — expires_at = createdAt + ttlMs */
    ttlMs: number;
  }
): Promise<boolean> {
  const client = store.db.$client;
  const createdAt = input.createdAt ?? Date.now();
  try {
    // BEGIN inside the try — a contended lock (SQLITE_BUSY) throws here,
    // and an escape would fail the caller's decision, not just the memo
    client.exec('BEGIN IMMEDIATE');
    const current = cacheGeneration(store.db, input.keyHash);
    if (current !== input.generation) {
      client.exec('ROLLBACK');
      return false;
    }
    client
      .prepare(
        `insert into decision_cache
           (key_hash, key_json, context_id, value_json, generation, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (key_hash) do update set
           key_json = excluded.key_json,
           context_id = excluded.context_id,
           value_json = excluded.value_json,
           generation = excluded.generation,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
      )
      .run(
        input.keyHash,
        input.keyJson,
        input.contextId,
        input.valueJson,
        input.generation,
        createdAt,
        createdAt + input.ttlMs
      );
    client.exec('COMMIT');
    tightenStoreFiles(store.path);
    return true;
  } catch (err) {
    rollback(client);
    console.error(
      `router-store: the cache write failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/** Invalidate a key — bump its generation and drop the entry, in one
 *  transaction. The generation moves even when no entry exists: that
 *  is what stops an in-flight miss (which captured the old generation
 *  before T2) from writing the failed answer back afterwards. Returns
 *  false on a store failure — warned, never thrown. */
export async function invalidateCacheKey(store: StoreFace, keyHash: string): Promise<boolean> {
  const client = store.db.$client;
  try {
    // BEGIN inside the try — same lock-contention rule as the write
    client.exec('BEGIN IMMEDIATE');
    const next = cacheGeneration(store.db, keyHash) + 1;
    client
      .prepare(
        `insert into decision_cache_gen (key_hash, generation) values (?, ?)
         on conflict (key_hash) do update set generation = excluded.generation`
      )
      .run(keyHash, next);
    client.prepare('delete from decision_cache where key_hash = ?').run(keyHash);
    client.exec('COMMIT');
    tightenStoreFiles(store.path);
    return true;
  } catch (err) {
    rollback(client);
    console.error(
      `router-store: the cache invalidation failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}
