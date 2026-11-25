import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mdPlain } from './lines.ts';

test('mdPlain removes markers exposed by other markers', () => {
  assert.deepEqual(mdPlain('***x***'), ['x']);
  assert.deepEqual(mdPlain('**bold** and `code` and [text](https://example.test)'), [
    'bold and code and text (https://example.test)',
  ]);
});

test('mdPlain handles hostile delimiter input in linear time', () => {
  const hostile = `${'*'.repeat(10_000)}x${'*'.repeat(10_000)}`;
  const started = performance.now();
  const result = mdPlain(hostile);
  const elapsed = performance.now() - started;

  assert.equal(result.length, 1);
  assert.ok(elapsed < 1000, `markdown scan took ${elapsed.toFixed(1)}ms`);
});
