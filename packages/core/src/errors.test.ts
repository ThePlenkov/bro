import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandError, isCommandError } from './errors.ts';
import { EXIT } from './exits.ts';

test('CommandError carries its classification and exit contract', () => {
  const error = new CommandError('invalid config', EXIT.error, undefined, undefined, 'config');

  assert.equal(error.name, 'CommandError');
  assert.equal(error.code, EXIT.error);
  assert.equal(error.classification, 'config');
  assert.equal(isCommandError(error), true);
});

test('isCommandError recognizes errors from a duplicate package copy', () => {
  assert.equal(isCommandError({ name: 'CommandError', message: 'failed', code: EXIT.error }), true);
  assert.equal(isCommandError(new Error('failed')), false);
});
