import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearExternalPlanes,
  externalPlanes,
  ownedEnviron,
  registerExternalPlane,
  type ExternalActivityPlane,
} from './external-planes.ts';

describe('external plane registry', () => {
  test('register, list, clear', () => {
    clearExternalPlanes();
    const p: ExternalActivityPlane = {
      kind: 'stub',
      externalActivity: () => ({ active: false }),
    };
    registerExternalPlane(p);
    assert.deepEqual(externalPlanes(), [p]);
    // re-registering a kind replaces it
    const p2: ExternalActivityPlane = {
      kind: 'stub',
      externalActivity: () => ({ active: true, detail: 'x' }),
    };
    registerExternalPlane(p2);
    assert.deepEqual(externalPlanes(), [p2]);
    clearExternalPlanes();
    assert.deepEqual(externalPlanes(), []);
  });
});

describe('ownedEnviron', () => {
  test("BRO_AGENT_ID pins the fleet's workers — NUL-anchored", () => {
    assert.equal(ownedEnviron('PATH=/bin\0BRO_AGENT_ID=native-abc\0HOME=/h\0'), true);
    // a lookalike suffix must not alias
    assert.equal(ownedEnviron('PATH=/bin\0XBRO_AGENT_ID=spoof\0'), false);
    // an EMPTY badge is not a badge
    assert.equal(ownedEnviron('BRO_AGENT_ID=\0'), false);
  });

  test("BRO_HOOKS=0 pins the acp pool's session children", () => {
    assert.equal(ownedEnviron('BRO_HOOKS=0\0PATH=/bin\0'), true);
    assert.equal(ownedEnviron('PATH=/bin\0BRO_HOOKS=0'), true);
    // another value is not the machine-backend mark
    assert.equal(ownedEnviron('BRO_HOOKS=1\0'), false);
    assert.equal(ownedEnviron('BRO_HOOKS=00\0'), false);
  });

  test('a foreign environ is not owned', () => {
    assert.equal(ownedEnviron('PATH=/bin\0HOME=/h\0'), false);
    assert.equal(ownedEnviron(''), false);
  });
});
