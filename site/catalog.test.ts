import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCatalog } from './catalog.ts';

function fixture(run: (root: string, pkg: (name: string, value: unknown) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'bro-catalog-'));
  mkdirSync(join(root, 'packages'));
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'site/planned-connectors.json'), '[]');
  try {
    run(root, (name, value) => {
      mkdirSync(join(root, 'packages', name), { recursive: true });
      writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify(value));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('catalog reads public metadata, excludes private packages and adds planned entries', () => {
  fixture((root, pkg) => {
    pkg('host', {
      name: '@broject/host',
      description: 'Host',
      bro: { kind: 'core', status: 'beta' },
    });
    pkg('internal', { private: true });
    writeFileSync(
      join(root, 'site/planned-connectors.json'),
      JSON.stringify([
        {
          name: 'Future',
          description: 'Later',
          source: 'specs/future.md',
          bro: { kind: 'connector', facade: 'tasks', status: 'planned' },
        },
      ])
    );
    const catalog = buildCatalog(root);
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0]?.npm, null);
    assert.equal(catalog[0]?.status, 'planned');
    assert.equal(catalog[1]?.npm, '@broject/host');
    assert.equal(catalog[1]?.source, 'packages/host');
  });
});

test('empty catalog is valid', () => fixture(root => assert.deepEqual(buildCatalog(root), [])));

test('missing or invalid public metadata fails independently of package descriptions', () => {
  fixture((root, pkg) => {
    for (const bro of [undefined, {}, { kind: 'connector', status: 'beta' }]) {
      pkg('bad', { name: '@broject/bad', description: 'Valid description', bro });
      assert.throws(() => buildCatalog(root), /packages\/bad\/package.json/);
    }
  });
});

test('missing descriptions fail for otherwise valid public packages', () => {
  fixture((root, pkg) => {
    pkg('bad', { name: '@broject/bad', bro: { kind: 'core', status: 'beta' } });
    assert.throws(
      () => buildCatalog(root),
      /packages\/bad\/package.json: Error: missing description/
    );
  });
});

test('planned entries reject invalid status, source and duplicate identity', () => {
  fixture(root => {
    const row = {
      name: 'Future',
      description: 'Later',
      source: 'specs/future.md',
      bro: { kind: 'connector', facade: 'tasks', status: 'planned' },
    };
    for (const rows of [
      [{ ...row, bro: { ...row.bro, status: 'beta' } }],
      [{ ...row, source: '../escape' }],
      [{ ...row, source: 'specs/a/../../etc/passwd' }],
      [row, row],
    ]) {
      writeFileSync(join(root, 'site/planned-connectors.json'), JSON.stringify(rows));
      assert.throws(() => buildCatalog(root));
    }
  });
});
