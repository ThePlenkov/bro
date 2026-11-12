import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { jsRuntime, toolSucceeded } from './opencode.ts';

// Modern OpenCode server plugin only (https://opencode.ai/docs/build/plugins/server/).
// Behavioral coverage lives in opencode.setup.test.ts (BroSetup).
describe('plugin shape', () => {
  test('default export declares id and setup', () => {
    const p = plugin as { id?: string; setup?: unknown; server?: unknown };
    assert.equal(p.id, 'bro');
    assert.equal(typeof p.setup, 'function');
    assert.equal(p.server, undefined);
  });
});

describe('jsRuntime', () => {
  test('never resolves to process.execPath', () => {
    assert.notEqual(jsRuntime(), process.execPath);
  });

  test('names a JS runtime bro can rely on', () => {
    assert.match(jsRuntime(), /^(node|node\.exe)$/);
  });
});

describe('toolSucceeded', () => {
  test('exit code wins over a missing error key', () => {
    assert.equal(toolSucceeded({ exit: 0 }), true);
    assert.equal(toolSucceeded({ exit: 1 }), false);
    assert.equal(toolSucceeded({ error: 'boom' }), false);
    assert.equal(toolSucceeded({ error: 'boom', exit: 0 }), false);
    assert.equal(toolSucceeded({}), true);
    assert.equal(toolSucceeded(null), true);
  });
});
