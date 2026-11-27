import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateUsageRows, type UsageRow } from './status-budget.ts';

const NOW = Date.parse('2026-02-03T12:00:00.000Z');

test('aggregates usage by agent, bead, provider, and model in both windows', () => {
  const rows: UsageRow[] = [
    {
      agent: 'a1',
      bead: 'b-1',
      provider: 'acme',
      model: 'm1',
      ts: '2026-02-03T10:00:00.000Z',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.25,
    },
    {
      agent: 'a1',
      bead: 'b-1',
      provider: 'acme',
      model: 'm1',
      ts: '2026-02-03T11:00:00.000Z',
      inputTokens: 20,
      outputTokens: 7,
      costUsd: 0.5,
    },
  ];

  const budget = aggregateUsageRows(rows, NOW);
  assert.equal(budget.day.rows, 2);
  assert.equal(budget.window.rows, 2);
  assert.deepEqual(budget.day.groups[0], {
    agent: 'a1',
    bead: 'b-1',
    provider: 'acme',
    model: 'm1',
    from: '2026-02-03T10:00:00.000Z',
    to: '2026-02-03T11:00:00.000Z',
    rows: 2,
    inputTokens: 30,
    outputTokens: 12,
    costUsd: 0.75,
    unknownCost: { count: 0, reason: 'provider did not report cost' },
  });
});

test('does not turn absent provider cost into zero', () => {
  const budget = aggregateUsageRows(
    [
      {
        agent: 'a2',
        provider: 'silent',
        model: 'm2',
        ts: '2026-02-03T11:00:00.000Z',
        inputTokens: 3,
        outputTokens: 4,
      },
    ],
    NOW
  );
  const group = budget.day.groups[0];
  assert.ok(group);
  assert.equal('costUsd' in group, false);
  assert.deepEqual(group.unknownCost, { count: 1, reason: 'provider did not report cost' });
  assert.equal(budget.day.unknownCostRows, 1);
});
