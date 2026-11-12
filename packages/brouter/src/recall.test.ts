import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecallOutcomeRow } from '@broject/router-store';
import { runT1, shouldInvokeT2 } from './cascade.ts';
import { recallDecision, recallTuning, recallVotes } from './recall.ts';
import type { RouteTable } from '@broject/router-routes';
import { routeTable } from '@broject/router-routes';

/** One recalled row — verified outcomes only ever reach recallVotes. */
const row = (
  route: string | null,
  result: string,
  rounds: number | null = 1
): RecallOutcomeRow => ({ route, result, rounds, at: 1 });

// ── recallTuning ────────────────────────────────────────────────────

test('recallTuning — defaults apply, nonsense clamps rather than disables', () => {
  assert.deepEqual(recallTuning(undefined), { k: 5, minAgreement: 0.6, minRows: 3 });
  assert.deepEqual(recallTuning({ k: 0, minAgreement: -1, minRows: 0 }), {
    k: 5,
    minAgreement: 0.6,
    minRows: 3,
  });
  assert.deepEqual(recallTuning({ k: 2.9, minAgreement: 1.4, minRows: 7 }), {
    k: 2,
    minAgreement: 1,
    minRows: 7,
  });
});

// ── recallVotes ─────────────────────────────────────────────────────

test('recallVotes — only contenders vote; success/failure/unlabelled split', () => {
  const rows = [
    row('pro', 'merged', 1), // success
    row('pro', 'merged', 1), // success
    row('pro', 'failed', 1), // failure
    row('pro', 'merged', null), // unlabelled under merged_first_round
    row('ghost', 'merged', 1), // not a contender — never votes
    row(null, 'merged', 1), // no route — never votes
  ];
  const { votes, order } = recallVotes(rows, ['pro', 'free']);
  assert.deepEqual(votes.get('pro'), { route: 'pro', successes: 2, failures: 1 });
  assert.equal(votes.get('free'), undefined);
  // pro leads on successes; free keeps its standing at the tail
  assert.deepEqual(order, ['pro', 'free']);
});

test('recallVotes — reorder is stable for unvoted contenders', () => {
  const { order } = recallVotes([row('c', 'merged', 1)], ['a', 'b', 'c']);
  assert.deepEqual(order, ['c', 'a', 'b']);
});

// ── recallDecision ──────────────────────────────────────────────────

test('recallDecision — agreement + row thresholds must both hold', () => {
  const votes = new Map([
    ['pro', { route: 'pro', successes: 3, failures: 0 }],
    ['free', { route: 'free', successes: 1, failures: 0 }],
  ]);
  const tuning = { k: 5, minAgreement: 0.6, minRows: 3 };
  // 3/4 = 75% ≥ 60%, 3 rows ≥ 3 → decides
  assert.equal(recallDecision(votes, tuning, ['pro', 'free']).decided, 'pro');
  // one fewer row → below minRows, reorders instead
  const thin = new Map([['pro', { route: 'pro', successes: 2, failures: 0 }]]);
  assert.equal(recallDecision(thin, tuning, ['pro', 'free']).decided, undefined);
  // a split vote → below agreement, reorders instead
  const split = new Map([
    ['pro', { route: 'pro', successes: 2, failures: 0 }],
    ['free', { route: 'free', successes: 2, failures: 0 }],
  ]);
  const verdict = recallDecision(split, tuning, ['pro', 'free']);
  assert.equal(verdict.decided, undefined);
  assert.match(verdict.note, /recall split/);
});

test('recallDecision — unanimous failures never decide a route', () => {
  const votes = new Map([['pro', { route: 'pro', successes: 0, failures: 4 }]]);
  const verdict = recallDecision(votes, { k: 5, minAgreement: 0.6, minRows: 3 }, ['pro']);
  assert.equal(verdict.decided, undefined);
  assert.match(verdict.note, /no verified successes/);
});

test('recallDecision — fewer failures breaks a success tie', () => {
  const votes = new Map([
    ['pro', { route: 'pro', successes: 3, failures: 2 }],
    ['free', { route: 'free', successes: 3, failures: 0 }],
  ]);
  // equal successes → fewer failures wins; agreement counts successes
  // only: 3 of 6 successes is 50% < 60% — still no decide, but the
  // winner selection itself prefers 'free'
  const verdict = recallDecision(votes, { k: 5, minAgreement: 0.4, minRows: 3 }, ['pro', 'free']);
  assert.equal(verdict.decided, 'free');
});

// ── shouldInvokeT2 ──────────────────────────────────────────────────

test('shouldInvokeT2 — always asks, never never asks', () => {
  assert.equal(
    shouldInvokeT2({ invoke: 'always', candidates: 1, pending: 0, pendingNeeds: false }).ask,
    true
  );
  assert.equal(
    shouldInvokeT2({ invoke: 'never', candidates: 3, pending: 2, pendingNeeds: true }).ask,
    false
  );
});

test('shouldInvokeT2 — ambiguous asks on contention or pending needs', () => {
  // one clean candidate — the whole point of the bead: no judge call
  assert.equal(
    shouldInvokeT2({ invoke: 'ambiguous', candidates: 1, pending: 0, pendingNeeds: false }).ask,
    false
  );
  // two contenders — ambiguous
  assert.equal(
    shouldInvokeT2({ invoke: 'ambiguous', candidates: 2, pending: 0, pendingNeeds: false }).ask,
    true
  );
  // one candidate + a pending route that still needs answers — ambiguous
  assert.equal(
    shouldInvokeT2({ invoke: 'ambiguous', candidates: 1, pending: 1, pendingNeeds: true }).ask,
    true
  );
  // pending routes with NO unresolved needs (filters already fired?) —
  // contenders still count: 1+1 = 2 → ask
  assert.equal(
    shouldInvokeT2({ invoke: 'ambiguous', candidates: 1, pending: 1, pendingNeeds: false }).ask,
    true
  );
  // zero contenders — nothing to pick, never ask
  assert.equal(
    shouldInvokeT2({ invoke: 'ambiguous', candidates: 0, pending: 0, pendingNeeds: false }).ask,
    false
  );
});

// ── runT1 with the rows seam ────────────────────────────────────────

const TABLE: RouteTable = routeTable({
  kind: 'route',
  routes: {
    pro: { chain: [{ provider: 'devin-acp' }] },
    free: { chain: [{ provider: 'kilo-free' }] },
  },
});

test('runT1 — decided recall reports the route and its stage', async () => {
  const rows = [row('pro', 'merged', 1), row('pro', 'merged', 1), row('pro', 'merged', 1)];
  const t1 = await runT1({
    dir: '/tmp',
    table: TABLE,
    text: 'fix the bug',
    contenders: ['pro', 'free'],
    tuning: { k: 5, minAgreement: 0.6, minRows: 3 },
    predicate: 'merged_first_round',
    rows,
  });
  assert.equal(t1.decided, 'pro');
  assert.equal(t1.stage.stage, 'T1');
  assert.equal(t1.stage.decided, 'pro');
  assert.match(t1.stage.note ?? '', /recall decided pro/);
});

test('runT1 — below threshold reorders and passes on', async () => {
  const rows = [row('free', 'merged', 1)];
  const t1 = await runT1({
    dir: '/tmp',
    table: TABLE,
    text: 'fix the bug',
    contenders: ['pro', 'free'],
    tuning: { k: 5, minAgreement: 0.6, minRows: 3 },
    predicate: 'merged_first_round',
    rows,
  });
  assert.equal(t1.decided, undefined);
  // free leads the reorder on its single success; pro keeps standing
  assert.deepEqual(t1.order, ['free', 'pro']);
  assert.match(t1.stage.note ?? '', /recall split|no verified/);
});

test('runT1 — an empty row set passes through with table order', async () => {
  const t1 = await runT1({
    dir: '/tmp',
    table: TABLE,
    text: 'anything',
    contenders: ['pro', 'free'],
    tuning: { k: 5, minAgreement: 0.6, minRows: 3 },
    predicate: 'merged_first_round',
    rows: [],
  });
  assert.equal(t1.decided, undefined);
  assert.deepEqual(t1.order, ['pro', 'free']);
});

test('runT1 — only the top-k ELIGIBLE rows vote (bro-0ykhg.2 review)', async () => {
  // k=2: rows 1-2 favor 'pro', rows 3-6 favor 'free'. Counting all six
  // would hand 'free' the win; the configured top-k must decide.
  const rows = [
    row('pro', 'merged', 1),
    row('pro', 'merged', 1),
    row('free', 'merged', 1),
    row('free', 'merged', 1),
    row('free', 'merged', 1),
    row('free', 'merged', 1),
    // a dead route never consumes a top-k slot
    row('ghost', 'merged', 1),
  ];
  const t1 = await runT1({
    dir: '/tmp',
    table: TABLE,
    text: 'fix the bug',
    contenders: ['pro', 'free'],
    tuning: { k: 2, minAgreement: 0.5, minRows: 2 },
    predicate: 'merged_first_round',
    rows,
  });
  assert.equal(t1.decided, 'pro', 'the top-2 eligible rows both favor pro');
});
