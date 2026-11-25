import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { profileModelFor } from './profile-model.ts';

/** The #813 invariant (bro-1lvvx item 2): a profile model may only be
 *  inherited by its own provider — an alien or absent provider never
 *  sees the pin. */
describe('profileModelFor — the provider/model pair invariant', () => {
  test('the matching provider inherits the profile model', () => {
    assert.equal(profileModelFor({ provider: 'minimax', model: 'm1' }, 'minimax'), 'm1');
  });

  test('an alien provider never inherits the model', () => {
    assert.equal(profileModelFor({ provider: 'minimax', model: 'm1' }, 'devin'), undefined);
  });

  test('no resolved lane means no model', () => {
    assert.equal(profileModelFor({ provider: 'minimax', model: 'm1' }, undefined), undefined);
  });

  test('no profile means no model', () => {
    assert.equal(profileModelFor(undefined, 'minimax'), undefined);
  });
});
