import { describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { inventory, select } from './test.ts';

describe('bro test select (bro-6xjvb)', () => {
  const root = '/repo';
  const files = [
    '/repo/packages/cli/src/commands/act.test.ts',
    '/repo/packages/cli/src/commands/act-wait.e2e.test.ts',
    '/repo/packages/act/src/wait.test.ts',
    '/repo/plugins/herdr/src/board.test.ts',
  ];

  test('a substring filter selects every carrying file', () => {
    assert.deepEqual(select(files, root, ['act-wait']), [
      '/repo/packages/cli/src/commands/act-wait.e2e.test.ts',
    ]);
    assert.deepEqual(select(files, root, ['wait']), [
      '/repo/packages/cli/src/commands/act-wait.e2e.test.ts',
      '/repo/packages/act/src/wait.test.ts',
    ]);
  });

  test('any-of semantics across filters', () => {
    const got = select(files, root, ['board', 'act/src']);
    assert.deepEqual(got, [
      '/repo/packages/act/src/wait.test.ts',
      '/repo/plugins/herdr/src/board.test.ts',
    ]);
  });

  test('no match selects nothing — the usage error path', () => {
    assert.deepEqual(select(files, root, ['nonexistent-xyz']), []);
  });
});

describe('bro test inventory', () => {
  test('a small fixture tree is walked without dist/node_modules and e2e-gated', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-test-inv-'));
    mkdirSync(join(root, 'packages', 'x', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'src', 'a.test.ts'), '');
    writeFileSync(join(root, 'packages', 'x', 'src', 'a.e2e.test.ts'), '');
    mkdirSync(join(root, 'packages', 'x', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'node_modules', 'dep', 'd.test.ts'), '');
    mkdirSync(join(root, 'packages', 'x', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'dist', 'b.test.ts'), '');
    const plain = inventory(root, false).map(f => f.slice(root.length + 1));
    assert.deepEqual(plain, ['packages/x/src/a.test.ts']);
    const withE2e = inventory(root, true).map(f => f.slice(root.length + 1));
    assert.equal(withE2e.length, 2);
    rmSync(root, { recursive: true, force: true });
  });
});
