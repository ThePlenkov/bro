import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeTable } from './schema.ts';
import { unservedChains } from './served.ts';

/** A table whose chains name the served ids. */
const TABLE = {
  kind: 'route',
  version: 1,
  routes: {
    edit: {
      match: { type: 'edit' },
      chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
    },
    bare: {
      match: { type: 'bare' },
      chain: [{ provider: 'kilo-free' }],
    },
  },
};

test('a route naming a model the declaration contradicts is unserved', () => {
  const found = unservedChains(routeTable(TABLE), { 'swe-2-max': [{ provider: 'devin-acp' }] });
  assert.equal(found.length, 0);
});

test('the same table under a contradicting declaration names the route and the model', () => {
  const table = routeTable({
    ...TABLE,
    routes: {
      edit: {
        match: { type: 'edit' },
        chain: [{ provider: 'devin-acp', model: 'claude-opus-5' }],
      },
    },
  });
  const found = unservedChains(table, { 'swe-2-max': [{ provider: 'devin-acp' }] });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.route, 'edit');
  assert.equal(found[0]?.model, 'claude-opus-5');
  assert.match(found[0]?.reason ?? '', /brouter\.models declares devin-acp for swe-2-max/);
});

test('a declaration silent about the provider is no verdict', () => {
  const found = unservedChains(routeTable(TABLE), { 'swe-2-max': [{ provider: 'other-lane' }] });
  assert.deepEqual(found, []);
});

test('an absent declaration is off — the router serves what its lanes advertise', () => {
  assert.deepEqual(unservedChains(routeTable(TABLE), {}), []);
});

test('a bare provider names the provider own model — nothing to contradict', () => {
  const found = unservedChains(routeTable(TABLE), { 'swe-2-max': [{ provider: 'kilo-free' }] });
  assert.deepEqual(found, []);
});

test('the declared model may be the upstream id the route pins', () => {
  const table = routeTable({
    ...TABLE,
    routes: {
      jev: {
        match: { type: 'jev' },
        chain: [{ provider: 'orcarouter', model: 'typesafe/jev-1.13' }],
      },
    },
  });
  const found = unservedChains(table, {
    jev: [{ provider: 'orcarouter', model: 'typesafe/jev-1.13' }],
  });
  assert.deepEqual(found, []);
});
