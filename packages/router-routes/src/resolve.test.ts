import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HealthSnapshot } from '@broject/core';
import { candidates } from './candidates.ts';
import { resolveRoute } from './resolve.ts';
import { routeTable } from './schema.ts';
import type { RouteTable } from './types.ts';

/** The table every case starts from — three routes, one catch-all. */
const TABLE: RouteTable = routeTable({
  kind: 'route',
  version: 1,
  routes: {
    edit: {
      match: { type: 'edit' },
      chain: [{ provider: 'devin-acp', model: 'swe-2-high' }],
      description: 'a small edit',
    },
    design: {
      match: { type: 'design', complexity: 'high' },
      chain: [{ provider: 'devin-acp', model: 'swe-2-high' }],
      description: 'a hard design',
    },
    fallback: {
      chain: [{ provider: 'kilo-free' }],
      description: 'anything else',
    },
  },
});

/** A wall on one model — the health the resolver reads. */
const WALLED: HealthSnapshot = {
  'devin-acp/swe-2-high': { available: false, reason: 'rate-limited', until: 900 },
};

test('a route whose match contradicts the task is rejected', () => {
  const set = candidates(TABLE, { type: 'design' }, {});
  const names = set.candidates.map(c => c.route.name);
  assert.ok(!names.includes('edit'), 'the edit route must not fit a design task');
  assert.equal(
    set.rejected.find(r => r.route.name === 'edit')?.reason,
    'type=edit does not fit type=design'
  );
});

test('a route that pins a field the task does not carry does not fit', () => {
  const set = candidates(TABLE, { complexity: 'high' }, {});
  const names = set.candidates.map(c => c.route.name);
  assert.ok(!names.includes('design'), 'the design route needs a type');
  assert.equal(
    set.rejected.find(r => r.route.name === 'design')?.reason,
    'the task carries no type'
  );
});

test('the route that pins the task scores above the catch-all', () => {
  const set = candidates(TABLE, { type: 'design', complexity: 'high' }, {});
  assert.equal(set.candidates[0]?.route.name, 'design');
  assert.equal(set.candidates[0]?.score, 2);
});

test('a route whose every model is walled is rejected', () => {
  const set = candidates(TABLE, { type: 'edit' }, WALLED);
  const rejected = set.rejected.find(r => r.route.name === 'edit');
  assert.ok(rejected !== undefined, 'the walled route must be rejected');
  assert.match(rejected.reason, /every model is walled/);
});

test('a route with one live model survives the wall on the other', () => {
  const table = routeTable({
    kind: 'route',
    routes: {
      mixed: {
        chain: [{ provider: 'devin-acp', model: 'swe-2-high' }, { provider: 'kilo-free' }],
      },
    },
  });
  const decision = resolveRoute(table, {}, WALLED);
  assert.equal(decision.route?.name, 'mixed');
  assert.deepEqual(decision.chain, [{ provider: 'kilo-free' }]);
});

test("the static resolver takes the table's own order", () => {
  const decision = resolveRoute(TABLE, { type: 'design', complexity: 'high' }, {});
  assert.equal(decision.route?.name, 'design');
  assert.equal(decision.picked, 'static');
  assert.match(decision.reason, /the table's own order/);
});

test("the decision model's pick wins when it names a candidate", () => {
  const decision = resolveRoute(
    TABLE,
    { type: 'design', complexity: 'high' },
    {},
    () => 'fallback'
  );
  assert.equal(decision.route?.name, 'fallback');
  assert.equal(decision.picked, 'model');
});

test('a pick that names no candidate never wins', () => {
  const decision = resolveRoute(TABLE, { type: 'design', complexity: 'high' }, {}, () => 'ghost');
  assert.equal(decision.route?.name, 'design');
  assert.equal(decision.picked, 'static');
  assert.match(decision.reason, /not a candidate/);
});

test('no candidate at all says why every route was rejected', () => {
  const table = routeTable({
    kind: 'route',
    routes: { only: { match: { type: 'edit' }, chain: [{ provider: 'devin-acp' }] } },
  });
  const decision = resolveRoute(table, { type: 'design' }, WALLED);
  assert.equal(decision.route, undefined);
  assert.match(decision.reason, /no route fits/);
});
