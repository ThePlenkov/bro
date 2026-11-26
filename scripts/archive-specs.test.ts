import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySpec } from './archive-specs.ts';

const input = (status: 'closed' | 'open' | 'unknown', referenced = false) =>
  classifySpec({ id: 'bro-test', path: 'specs/bro-test.md', status, referenced });

test('closed and unreferenced specs are archive candidates', () => {
  assert.equal(input('closed').reason, 'archive');
});

test('open specs stay live', () => {
  assert.equal(input('open').reason, 'open');
  assert.equal(input('unknown').reason, 'unknown');
});

test('referenced closed specs stay live', () => {
  assert.equal(input('closed', true).reason, 'referenced');
});
