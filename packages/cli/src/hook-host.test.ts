import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hookHostOf } from './hook-host.ts';

describe('hookHostOf', () => {
  test('mirrors run.sh env markers and payload fingerprints', () => {
    assert.equal(hookHostOf({ CURSOR_PLUGIN_ROOT: '/x' }), 'cursor');
    assert.equal(hookHostOf({ DEVIN_PLUGIN_ROOT: '/x' }), 'devin');
    assert.equal(hookHostOf({ CLAUDE_PLUGIN_ROOT: '/x' }), 'claude');
    assert.equal(hookHostOf({ CURSOR_PROJECT_DIR: '/p' }), 'cursor');
    assert.equal(hookHostOf({ DEVIN_PROJECT_DIR: '/p' }), 'devin');
    assert.equal(hookHostOf({ PLUGIN_ROOT: '/p' }), 'codex');
    assert.equal(hookHostOf({}, { turn_id: 't1' }), 'codex');
    assert.equal(hookHostOf({}, { cursor_version: '1' }), 'cursor');
    assert.equal(hookHostOf({}, {}), 'unknown');
    assert.equal(hookHostOf({}), 'unknown');
  });

  test('explicit BRO_HOOK_HOST wins when slug-shaped', () => {
    for (const kind of ['xhost', 'emit-host-9', 'h2']) {
      assert.equal(hookHostOf({ BRO_HOOK_HOST: kind }), kind);
    }
    assert.equal(hookHostOf({ BRO_HOOK_HOST: 'xhost', CURSOR_PLUGIN_ROOT: '/x' }), 'xhost');
    assert.equal(hookHostOf({ BRO_HOOK_HOST: 'UPPER!' }), 'unknown');
    assert.equal(hookHostOf({ BRO_HOOK_HOST: '', CURSOR_PLUGIN_ROOT: '/x' }), 'cursor');
  });
});
