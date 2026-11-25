import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPackEntries } from './pack-entries.ts';

test('extracts entries from npm pack array output', () => {
  assert.deepEqual(
    extractPackEntries([{ files: [{ path: 'pack.json' }, { path: 'README.md' }] }]),
    ['pack.json', 'README.md']
  );
});

test('extracts entries from npm 12 package-name-keyed output', () => {
  assert.deepEqual(
    extractPackEntries({
      '@broject/bro-pack': { files: [{ path: 'pack.json' }] },
    }),
    ['pack.json']
  );
});

test('returns no entries for an unrecognized pack output', () => {
  assert.deepEqual(extractPackEntries({ '@broject/bro-pack': { files: [] } }), []);
  assert.deepEqual(extractPackEntries({}), []);
  assert.deepEqual(extractPackEntries(null), []);
});
