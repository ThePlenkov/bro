import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainSpawn } from './loop-explain.ts';
import type { RouteTableLane } from './loop-routes.ts';

/** The lane the route table resolved — the verdict rides with it. */
const ROUTED: RouteTableLane = {
  class: 'edit',
  chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
  provider: 'devin-acp',
  model: 'swe-2-max',
  decision: {
    route: {
      name: 'edit',
      match: { type: 'edit' },
      chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
    },
    chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
    dropped: [],
    candidates: [],
    rejected: [],
    reason: "the table's own order — edit (type=edit)",
    picked: 'static',
  },
  snapshot: {},
};

/** What the explanation printed — stderr, so stdout stays the run log. */
function capture(run: () => void): string {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => {
    lines.push(String(line));
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

test('the spawn path prints the routing story — the route and the model', () => {
  const text = capture(() => {
    explainSpawn({ slices: ['route', 'model'], bead: 'bro-1', routed: ROUTED });
  });
  assert.match(text, /loop: bro-1/);
  assert.match(text, /route: edit — the table's own order/);
  assert.match(text, /model: swe-2-max — the route "edit" pins it/);
});

test('the slices the operator did not ask for stay silent', () => {
  const text = capture(() => {
    explainSpawn({ slices: ['model'], bead: 'bro-1', routed: ROUTED });
  });
  assert.doesNotMatch(text, /^route$/m);
  assert.match(text, /^model$/m);
});

test('no flag, no story', () => {
  const text = capture(() => {
    explainSpawn({ bead: 'bro-1', routed: ROUTED });
  });
  assert.equal(text, '');
});
