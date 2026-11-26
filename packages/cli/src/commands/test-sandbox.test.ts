import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTestSandbox } from '../../scripts/test-sandbox.ts';

test('test sandbox cleanup removes interrupted fixture litter', () => {
  const sandbox = createTestSandbox({ ...process.env, TMPDIR: '/tmp/original' });
  const fixture = join(sandbox.dir, 'bro-fixture', 'tmp-child');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'left-behind'), 'fixture');

  assert.equal(sandbox.env.TMPDIR, sandbox.dir);
  assert.equal(existsSync(fixture), true);
  sandbox.cleanup();
  assert.equal(existsSync(sandbox.dir), false);
  sandbox.cleanup();
});
