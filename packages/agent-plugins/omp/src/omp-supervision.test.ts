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
