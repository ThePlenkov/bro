import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  cacheGeneration,
  invalidateCacheKey,
  migrateStore,
  openStore,
  readCacheEntry,
  writeCacheEntry,
} from './index.ts';
import type { StoreHandle } from './store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-cache-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A migrated store in a fresh file — the shape every case starts from. */
async function store(name: string) {
  const path = join(scratch, `${name}.db`);
  const handle = openStore(path);
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  migrateStore(handle.db);
  return handle as Extract<StoreHandle, { ok: true }>;
}

const KEY = {
  keyHash: 'k'.repeat(64),
  keyJson: '{"v":1}',
  contextId: 'ctx:test',
  valueJson: '{"kind":"pick","pick":"a"}',
};

test('a write lands and reads back — generation, TTL, value', async () => {
  const s = await store('roundtrip');
  const now = 1_000_000;
  const ok = await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 60_000, createdAt: now });
  assert.equal(ok, true);
  const entry = readCacheEntry(s.db, KEY.keyHash, now + 1);
  assert.ok(entry !== undefined);
  assert.equal(entry.keyHash, KEY.keyHash);
  assert.equal(entry.keyJson, KEY.keyJson);
  assert.equal(entry.contextId, KEY.contextId);
  assert.equal(entry.valueJson, KEY.valueJson);
  assert.equal(entry.generation, 0);
  assert.equal(entry.createdAt, now);
  assert.equal(entry.expiresAt, now + 60_000);
  assert.equal(cacheGeneration(s.db, KEY.keyHash), 0);
  s.close();
});

test('the TTL expires the entry — a stale answer never serves', async () => {
  const s = await store('ttl');
  const now = 2_000_000;
  await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 1_000, createdAt: now });
  assert.ok(readCacheEntry(s.db, KEY.keyHash, now + 999) !== undefined);
  assert.equal(readCacheEntry(s.db, KEY.keyHash, now + 1_000), undefined);
  assert.equal(readCacheEntry(s.db, KEY.keyHash, now + 5_000), undefined);
  s.close();
});

test('invalidation bumps the generation even with no entry — and drops one', async () => {
  const s = await store('invalidate');
  // a key never seen: the generation still moves — that is what stops
  // an in-flight miss from writing the failed answer back afterwards
  assert.equal(cacheGeneration(s.db, 'never-seen'), 0);
  assert.equal(await invalidateCacheKey(s, 'never-seen'), true);
  assert.equal(cacheGeneration(s.db, 'never-seen'), 1);
  assert.equal(await invalidateCacheKey(s, 'never-seen'), true);
  assert.equal(cacheGeneration(s.db, 'never-seen'), 2);
  // and a live entry dies with its generation bump
  await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 60_000 });
  assert.ok(readCacheEntry(s.db, KEY.keyHash) !== undefined);
  assert.equal(await invalidateCacheKey(s, KEY.keyHash), true);
  assert.equal(readCacheEntry(s.db, KEY.keyHash), undefined);
  assert.equal(cacheGeneration(s.db, KEY.keyHash), 1);
  s.close();
});

test('the write is a compare-and-set — a stale generation rejects', async () => {
  const s = await store('cas');
  const now = 3_000_000;
  // the ordinary flow: consult at gen 0, write at gen 0 — lands
  assert.equal(
    await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 60_000, createdAt: now }),
    true
  );
  // a second consult still sees gen 0 — the entry does not bump it
  assert.equal(cacheGeneration(s.db, KEY.keyHash), 0);
  // an invalidation lands while a decision is mid-flight
  assert.equal(await invalidateCacheKey(s, KEY.keyHash), true);
  assert.equal(cacheGeneration(s.db, KEY.keyHash), 1);
  // the in-flight write captured gen 0 — it must NOT resurrect the
  // answer the verified failure just disproved
  assert.equal(
    await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 60_000, createdAt: now + 1 }),
    false
  );
  assert.equal(readCacheEntry(s.db, KEY.keyHash, now + 2), undefined);
  // a write that captured the NEW generation lands
  assert.equal(
    await writeCacheEntry(s, { ...KEY, generation: 1, ttlMs: 60_000, createdAt: now + 3 }),
    true
  );
  const entry = readCacheEntry(s.db, KEY.keyHash, now + 4);
  assert.equal(entry?.generation, 1);
  assert.equal(entry?.createdAt, now + 3);
  s.close();
});

test('a rewrite replaces the entry under the same generation', async () => {
  const s = await store('rewrite');
  const now = 4_000_000;
  await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 60_000, createdAt: now });
  await writeCacheEntry(s, {
    ...KEY,
    valueJson: '{"kind":"pick","pick":"b"}',
    generation: 0,
    ttlMs: 60_000,
    createdAt: now + 10,
  });
  const entry = readCacheEntry(s.db, KEY.keyHash, now + 11);
  assert.equal(entry?.valueJson, '{"kind":"pick","pick":"b"}');
  assert.equal(entry?.createdAt, now + 10);
  s.close();
});

test('expired rows are swept on the next write — text does not outlive its TTL', async () => {
  const s = await store('sweep');
  const t0 = 5_000_000;
  const expiredHash = 'e'.repeat(64);
  const liveHash = 'l'.repeat(64);
  // dead at the NEXT write's clock — its key_json still carries task text
  assert.equal(
    await writeCacheEntry(s, {
      ...KEY,
      keyHash: expiredHash,
      keyJson: '{"v":1,"task":{"text":"a task that mentioned a token"}}',
      generation: 0,
      ttlMs: 1_000,
      createdAt: t0,
    }),
    true
  );
  assert.equal(
    await writeCacheEntry(s, {
      ...KEY,
      keyHash: liveHash,
      generation: 0,
      ttlMs: 60_000,
      createdAt: t0 + 2_000,
    }),
    true
  );
  // the live write's transaction swept the dead row — the text is gone,
  // not lingering past the TTL (bro-0ykhg.3 review)
  const rows = s.db.$client.prepare('select key_hash from decision_cache').all() as Array<{
    key_hash: string;
  }>;
  assert.deepEqual(
    rows.map(r => r.key_hash),
    [liveHash]
  );
  s.close();
});

test('invalidation sweeps expired rows too', async () => {
  const s = await store('sweep-invalidate');
  const t0 = 6_000_000;
  await writeCacheEntry(s, { ...KEY, generation: 0, ttlMs: 1_000, createdAt: t0 });
  // invalidating a DIFFERENT key still runs the sweep in its transaction
  assert.equal(await invalidateCacheKey(s, 'other-key'), true);
  const row = s.db.$client.prepare('select count(*) as n from decision_cache').get() as {
    n: number;
  };
  assert.equal(row.n, 0);
  s.close();
});
