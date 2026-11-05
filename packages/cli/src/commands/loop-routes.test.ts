import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SpawnError } from '@broject/core';
import { routeTableLane } from './loop-routes.ts';

const scratch = mkdtempSync(join(tmpdir(), 'bro-loop-routes-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A route table on disk — the operator's own file. */
function tableFile(body: string): string {
  const file = join(scratch, `routes-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(file, body);
  return file;
}

const TABLE = [
  'kind = "route"',
  'version = 1',
  '',
  '[routes.sweep]',
  'match = { type = "sweep" }',
  'chain = [{ provider = "devin-acp", model = "claude-opus-5" }]',
  'onWall = "fallthrough"',
  '',
  '[routes.fallback]',
  'chain = [{ provider = "kilo-free" }]',
  '',
].join('\n');

test("no table means no route — the fleet's own routing stands", async () => {
  assert.equal(await routeTableLane({}), undefined);
});

test("the bead's class lands on the route that pins it", async () => {
  const routed = await routeTableLane({ table: tableFile(TABLE), label: 'sweep' });
  assert.equal(routed?.class, 'sweep');
  assert.equal(routed?.provider, 'devin-acp');
  assert.equal(routed?.model, 'claude-opus-5');
  assert.equal(routed?.onWall, 'fallthrough');
});

test('the explicit class outranks the label', async () => {
  const routed = await routeTableLane({
    table: tableFile(TABLE),
    class: 'sweep',
    label: 'something-else',
  });
  assert.equal(routed?.class, 'sweep');
});

test('a bead with no class falls on the catch-all route', async () => {
  const routed = await routeTableLane({ table: tableFile(TABLE) });
  assert.equal(routed?.class, 'fallback');
  assert.equal(routed?.provider, 'kilo-free');
});

test('a broken table is a config error, never a silent fallback', async () => {
  const file = tableFile('kind = "route"\n\n[routes.sweep]\nchain = []\n');
  await assert.rejects(() => routeTableLane({ table: file }), SpawnError);
});
