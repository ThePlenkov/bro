import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSupervisionHost, supervise } from './supervision.ts';

test('supervise falls back with an explicit ownership reason', async () => {
  const result = await supervise({
    name: 'test',
    env: {},
    detached: async () => 42,
  });
  assert.deepEqual(result, {
    substrate: 'detached',
    handle: 42,
    reason: 'no host supervision capability',
  });
});

test('supervise uses a registered host when the marker is present', async () => {
  const remove = registerSupervisionHost('test-host', {
    supervise: async spec => spec.native?.() ?? spec.detached(),
  });
  try {
    const result = await supervise({
      name: 'test',
      env: { BRO_SUPERVISION_HOST: 'test-host' },
      native: async () => 'native',
      detached: async () => 'detached',
    });
    assert.deepEqual(result, { substrate: 'host', handle: 'native' });
  } finally {
    remove();
  }
});
