/** agents plane — the delegate verb's error vocabulary boundary
 *  (execOrPlaneError): caller input is a client bug (PlaneVerbError →
 *  REST 400), a refusal or an unreachable backend is PlaneUnavailable
 *  (→ 503), anything else propagates. The pin that matters: a provider
 *  wall caught by the EARLY refuseWalled gate arrives as
 *  SpawnError('cap'), the SAME wall caught at turn admission arrives
 *  unwrapped as AcpCooldownError (spec bro-acjzf) — both refuse the
 *  spend, so both land on the identical 503. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { JudgeUnavailable, PlaneUnavailable, PlaneVerbError, SpawnError } from '@broject/core';
import { AcpCooldownError } from '@broject/providers';
import { SpawnInputError } from '../commands/agents.ts';
import { execOrPlaneError } from './agents.ts';

describe('agents plane — delegate error vocabulary', () => {
  test('early + late wall verdicts land on the same PlaneUnavailable (bro-acjzf)', () => {
    const walled = 'p walled — rate_limited — the delegate lane waits';
    for (const err of [
      // refuseWalled — the early gate's refusal
      new SpawnError(walled, 'cap'),
      // guard.cooldown inside acpSessionOpen — a wall that lands in the
      // refuseWalled → session/new window, arriving unwrapped
      new AcpCooldownError({ reason: walled, retryAfterSec: 30 }),
      // an unreachable ACP peer — availability, already mapped
      new JudgeUnavailable(`acp delegate:p unavailable — ${walled}`),
    ]) {
      assert.throws(
        () => execOrPlaneError(err),
        (e: unknown) => e instanceof PlaneUnavailable,
        `${err.name} must map to PlaneUnavailable (→ 503), not a bare 500`
      );
    }
  });

  test('caller input stays a client bug — PlaneVerbError (→ 400)', () => {
    for (const err of [
      new SpawnInputError('delegate --wait needs a provider'),
      new SpawnError('providers.p is not configured', 'input'),
    ]) {
      assert.throws(() => execOrPlaneError(err), PlaneVerbError);
    }
  });

  test('an unknown failure propagates verbatim — never a fake verdict', () => {
    const err = new Error('something else broke');
    assert.throws(
      () => execOrPlaneError(err),
      (e: unknown) => e === err
    );
  });
});
