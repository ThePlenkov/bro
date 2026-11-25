import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { unmodifiedKeyName } from './serve.ts';

describe('the default serve keymap', () => {
  test('control-letter chords never match plain-letter bindings', () => {
    assert.equal(unmodifiedKeyName({ name: 'a', ctrl: true }), undefined);
    assert.equal(unmodifiedKeyName({ name: 'z', ctrl: true }), undefined);
    assert.equal(unmodifiedKeyName({ name: 'c', ctrl: true }), undefined);
  });

  test('plain keys remain available to the browse bindings', () => {
    assert.equal(unmodifiedKeyName({ name: 'a', ctrl: false }), 'a');
    assert.equal(unmodifiedKeyName({ name: 'z' }), 'z');
  });
});
