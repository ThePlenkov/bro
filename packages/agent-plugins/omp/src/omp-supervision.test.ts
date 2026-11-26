import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installOmpSupervision } from './omp-supervision.ts';

test('omp polls and steer-delivers the settled value', async () => {
  const messages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const remove = installOmpSupervision({
    sendMessage(message, options) {
      messages.push({ content: message.content, options });
    },
  }, 10);
  try {
    const { supervise } = await import('@broject/core');
    const result = await supervise({
      name: 'gate',
      env: { BRO_SUPERVISION_HOST: 'omp' },
      native: async () => 'green',
      detached: async () => 'detached',
      message: value => `gate: ${value}`,
    });
    assert.equal(result.handle, 'green');
    assert.equal(messages[0]?.content, 'gate: green');
    assert.equal(messages[0]?.options?.deliverAs, 'steer');
  } finally {
    remove();
  }
});

test('omp does not overlap native polls', async () => {
  let active = 0;
  let peak = 0;
  const remove = installOmpSupervision({
    sendMessage() {},
  }, 1);
  try {
    const { supervise } = await import('@broject/core');
    const result = await supervise({
      name: 'slow gate',
      env: { BRO_SUPERVISION_HOST: 'omp' },
      native: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return 'green';
      },
      detached: async () => 'detached',
    });
    assert.equal(result.handle, 'green');
    assert.equal(peak, 1);
  } finally {
    remove();
  }
});
