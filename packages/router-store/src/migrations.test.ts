import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { migrateStore, migrationIds } from './migrations.ts';
import { limits, migrations, sessions, usage } from './schema.ts';
import { openStore } from './store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-migrations-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The tables the drizzle schema declares — the drift test walks them. */
const TABLES = [usage, limits, sessions, migrations];

test('the schema and the SQL agree — every table, every column', async () => {
  const handle = openStore(join(scratch, 'drift.db'));
  assert.ok(handle.ok);
  await migrateStore(handle.db);
  for (const table of TABLES) {
    const config = getTableConfig(table);
    const rows = handle.db.$client.prepare(`pragma table_info("${config.name}")`).all() as {
      name: string;
    }[];
    const actual = rows.map(row => row.name);
    assert.deepEqual(
      actual,
      config.columns.map(c => c.name),
      config.name
    );
  }
  handle.close();
});

test('a second run applies nothing — the store is opened by every command', async () => {
  const handle = openStore(join(scratch, 'idempotent.db'));
  assert.ok(handle.ok);
  const first = await migrateStore(handle.db);
  const second = await migrateStore(handle.db);
  assert.deepEqual(first, migrationIds());
  assert.deepEqual(second, []);
  handle.close();
});

test('the bookkeeping table remembers what ran', async () => {
  const handle = openStore(join(scratch, 'bookkeeping.db'));
  assert.ok(handle.ok);
  await migrateStore(handle.db);
  const rows = handle.db.$client.prepare('select id from migrations').all();
  assert.deepEqual(
    rows.map(r => r.id as string),
    migrationIds()
  );
  handle.close();
});
