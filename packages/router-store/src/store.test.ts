import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrateStore } from './migrations.ts';
import {
  activeLimits,
  clearLimit,
  closeSession,
  openSession,
  openSessions,
  openStore,
  recordLimit,
  recordUsage,
  storeStats,
  usageInWindow,
} from './store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-store-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A migrated store in a fresh file — the shape every case starts from. */
async function store(name: string) {
  const path = join(scratch, `${name}.db`);
  const handle = openStore(path);
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  await migrateStore(handle.db);
  return handle;
}

test('the traffic of one window accumulates on the same row', async () => {
  const s = await store('usage');
  await recordUsage(s.db, {
    provider: 'devin-acp',
    model: 'swe-2-high',
    windowStart: 1000,
    requests: 2,
    tokens: 40,
  });
  await recordUsage(s.db, {
    provider: 'devin-acp',
    model: 'swe-2-high',
    windowStart: 1000,
    requests: 3,
    tokens: 10,
  });
  const window = await usageInWindow(s.db, {
    provider: 'devin-acp',
    model: 'swe-2-high',
    since: 0,
    until: 2000,
  });
  assert.deepEqual(window, { requests: 5, tokens: 50 });
  s.close();
});

test('a window that ends before the row does not count it', async () => {
  const s = await store('usage-window');
  await recordUsage(s.db, {
    provider: 'p',
    model: 'm',
    windowStart: 5000,
    requests: 7,
    tokens: 1,
  });
  const window = await usageInWindow(s.db, { provider: 'p', model: 'm', since: 0, until: 1000 });
  assert.equal(window.requests, 0);
  s.close();
});

test('a wall holds until its reset and lifts when cleared', async () => {
  const s = await store('limits');
  await recordLimit(s.db, {
    provider: 'devin-acp',
    model: 'm',
    resetAt: 900,
    reason: 'rate-limited',
    source: 'devin',
    seenAt: 100,
  });
  const held = await activeLimits(s.db, 500);
  assert.equal(held.length, 1);
  assert.equal(held[0]?.resetAt, 900);
  await clearLimit(s.db, 'devin-acp', 'm');
  assert.deepEqual(await activeLimits(s.db, 500), []);
  s.close();
});

test('a wall whose reset has passed is not a wall anymore', async () => {
  const s = await store('limits-expired');
  await recordLimit(s.db, {
    provider: 'p',
    model: 'm',
    resetAt: 100,
    reason: 'quota',
    source: 'src',
    seenAt: 50,
  });
  assert.deepEqual(await activeLimits(s.db, 200), []);
  s.close();
});

test('a session is open until it is closed', async () => {
  const s = await store('sessions');
  await openSession(s.db, {
    id: 's1',
    provider: 'p',
    model: 'm',
    startedAt: 10,
    meta: '{"bead":"b-1"}',
  });
  const open = await openSessions(s.db);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.meta, '{"bead":"b-1"}');
  await closeSession(s.db, 's1', 20);
  assert.deepEqual(await openSessions(s.db), []);
  s.close();
});

test('the stats count what the ledger holds', async () => {
  const s = await store('stats');
  await recordUsage(s.db, {
    provider: 'p',
    model: 'm',
    windowStart: 1,
    requests: 1,
    tokens: 1,
  });
  await openSession(s.db, { id: 's1', provider: 'p', model: 'm', startedAt: 1 });
  const stats = await storeStats(s.db);
  assert.deepEqual(stats, { usage: 1, limits: 0, sessions: 1 });
  s.close();
});

test('a broken store costs the numbers, never the run', async () => {
  const s = await store('broken');
  s.close();
  const recorded = await recordUsage(s.db, {
    provider: 'p',
    model: 'm',
    windowStart: 1,
    requests: 1,
    tokens: 1,
  });
  assert.equal(recorded, false);
  assert.deepEqual(await usageInWindow(s.db, { provider: 'p', model: 'm', since: 0, until: 9 }), {
    requests: 0,
    tokens: 0,
  });
});
