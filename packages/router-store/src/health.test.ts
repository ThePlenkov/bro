import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { healthSnapshot } from './health.ts';
import { migrateStore } from './migrations.ts';
import { openSession, openStore, recordLimit } from './store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-health-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A migrated store in a fresh file — the shape every case starts from. */
async function store(name: string) {
  const path = join(scratch, `${name}.db`);
  const handle = openStore(path);
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  await migrateStore(handle.db);
  return handle;
}

test('a wall makes the model unavailable, with the reason and the reset', async () => {
  const s = await store('wall');
  await recordLimit(s.db, {
    provider: 'devin-acp',
    model: 'swe-2-max',
    resetAt: 900,
    reason: 'rate-limited',
    source: 'devin',
    seenAt: 100,
  });
  const snapshot = await healthSnapshot(s.db, 500);
  const verdict = snapshot['devin-acp/swe-2-max'];
  assert.equal(verdict?.available, false);
  assert.equal(verdict?.reason, 'rate-limited');
  assert.equal(verdict?.until, 900);
  s.close();
});

test('a wall the ledger never heard of is not a wall', async () => {
  const s = await store('silent');
  const snapshot = await healthSnapshot(s.db, 500);
  assert.deepEqual(snapshot, {});
  s.close();
});

test('the open sessions ride along as a fact, not a verdict', async () => {
  const s = await store('sessions');
  await openSession(s.db, { id: 'a', provider: 'p', model: 'm', startedAt: 1 });
  await openSession(s.db, { id: 'b', provider: 'p', model: 'm', startedAt: 2 });
  const snapshot = await healthSnapshot(s.db, 500);
  const verdict = snapshot['p/m'];
  assert.equal(verdict?.available, true);
  assert.equal(verdict?.openSessions, 2);
  s.close();
});

test('a reason the ledger does not know still means a wall', async () => {
  const s = await store('unknown-reason');
  await recordLimit(s.db, {
    provider: 'p',
    model: 'm',
    resetAt: 900,
    reason: 'weird-word',
    source: 'src',
    seenAt: 1,
  });
  const verdict = (await healthSnapshot(s.db, 2))['p/m'];
  assert.equal(verdict?.available, false);
  assert.equal(verdict?.reason, 'rate-limited');
  s.close();
});
