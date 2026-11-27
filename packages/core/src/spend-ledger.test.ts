import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSpend, spendSummary } from './spend-ledger.ts';

test('spend ledger aggregates priced and token-only provider rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'bro-spend-'));
  const path = join(root, 'spend.jsonl');
  try {
    recordSpend({ ts: new Date().toISOString(), bead: 'b1', provider: 'one', costUsd: 1.25 }, path);
    recordSpend({ ts: new Date().toISOString(), bead: 'b1', provider: 'two', inputTokens: 40 }, path);
    recordSpend({ ts: new Date().toISOString(), bead: 'b2', provider: 'one', costUsd: 0.75 }, path);
    assert.deepEqual(spendSummary(path), {
      basis: 'provider-reported',
      rows: 3,
      unknownCostRows: 1,
      totalCostUsd: 2,
      byBead: [
        { bead: 'b1', costUsd: 1.25, rows: 2 },
        { bead: 'b2', costUsd: 0.75, rows: 1 },
      ],
      byProvider: [
        { provider: 'one', costUsd: 2, rows: 2 },
        { provider: 'two', rows: 1 },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spend ledger rejects malformed rows instead of recording zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'bro-spend-'));
  try {
    assert.throws(
      () =>
        recordSpend(
          { ts: new Date().toISOString(), bead: 'b1', provider: 'one', costUsd: Number.NaN },
          join(root, 'spend.jsonl')
        ),
      /invalid provider usage row/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
