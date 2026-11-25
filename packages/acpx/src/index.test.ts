import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchiveClient } from './index.ts';

test('archive client keeps the CLI JSON seam in one place', () => {
  const client = createArchiveClient({ executable: 'acpx' });
  assert.equal(typeof client.exportSession, 'function');
  assert.equal(typeof client.importSession, 'function');
  assert.equal(typeof client.pruneSession, 'function');
});
