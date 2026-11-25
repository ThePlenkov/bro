import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitise } from './sanitiser.ts';

test('keeps LF and HT executed inside a CSI sequence', () => {
  assert.equal(sanitise('before\u001b[12\n\t34mafter'), 'before\n\tafter');
});

test('CAN aborts a CSI sequence', () => {
  assert.equal(sanitise('before\u001b[12\u0018after'), 'beforeafter');
});

test('SUB aborts a CSI sequence', () => {
  assert.equal(sanitise('before\u001b[12\u001aafter'), 'beforeafter');
});
